"""Tests for fault scheduling, labels and the effect of each fault type (fault injection only)."""

import numpy as np
import pandas as pd
import pytest

from anomaly_engine.faults import FAULT_TYPES, FaultEvent, build_modifiers, schedule_faults
from anomaly_engine.features import SERVICES
from anomaly_engine.generator import Modifiers, generate_service, service_rng
from anomaly_engine.profiles import get_profile


def schedule(seed=0, **kwargs):
    rng = np.random.default_rng(seed)
    params = dict(services=SERVICES, first_window=1000, n_windows=2880, events_per_service=12)
    params.update(kwargs)
    return schedule_faults(rng, **params)


def run(service, event, n=220, seed=7):
    mods = build_modifiers([event], service, n)
    frame = generate_service(get_profile(service), n, service_rng(seed, service), 0, mods)
    inside = frame[frame["label"] == 1]
    outside = frame[(frame["label"] == 0) & (frame["window"] >= 40) & (frame["window"] < 100)]
    return frame, inside, outside


def event(fault_type, intensity=1.0, ramp=0, start=100, end=160, service="payment-service"):
    return FaultEvent(0, service, fault_type, start, end, intensity, ramp)


# ------------------------------------------------------------------ scheduling and labels
def test_schedule_is_deterministic():
    assert schedule(3) == schedule(3)
    assert schedule(3) != schedule(4)


def test_events_are_inside_the_segment_ordered_and_separated():
    events = schedule(1)
    assert len(events) == 12 * len(SERVICES)
    assert [e.event_id for e in events] == list(range(len(events)))
    for service in SERVICES:
        mine = [e for e in events if e.service == service]
        assert len(mine) == 12
        for e in mine:
            assert 1000 <= e.start and e.end <= 1000 + 2880
            assert 4 <= e.length <= 20
            assert e.ramp_windows == 0 or 2 <= e.ramp_windows <= 6
            assert 0 <= e.intensity <= 1
        for a, b in zip(mine, mine[1:]):
            assert b.start - a.end >= 10, "events on one service must be separated by the minimum gap"


def test_all_five_fault_types_are_scheduled():
    seen = {e.fault_type for seed in range(5) for e in schedule(seed)}
    assert seen == set(FAULT_TYPES)


def test_too_many_events_for_the_segment_is_rejected():
    with pytest.raises(ValueError):
        schedule(0, n_windows=100, events_per_service=12)


def test_labels_cover_exactly_the_event_windows_and_nothing_else():
    e1, e2 = event("error_burst", start=50, end=60), event("hang", start=100, end=118)
    mods = build_modifiers([e1, e2], "payment-service", 200)
    assert mods.label[50:60].all() and mods.label[100:118].all()
    assert mods.label.sum() == 10 + 18
    assert set(mods.fault_type[50:60]) == {"error_burst"} and set(mods.fault_type[100:118]) == {"hang"}
    assert (mods.event_id[50:60] == 0).all() and (mods.event_id[mods.label == 0] == -1).all()


def test_other_services_are_not_labelled_and_out_of_range_events_are_rejected():
    mods = build_modifiers([event("hang")], "order-service", 200)
    assert mods.label.sum() == 0
    with pytest.raises(ValueError):
        build_modifiers([event("hang", start=190, end=230)], "payment-service", 200)


# ------------------------------------------------------------------ effects of each fault
def test_error_burst_raises_the_error_rate():
    _, inside, outside = run("payment-service", event("error_burst"))
    assert inside["error_rate"].mean() > 0.4 and outside["error_rate"].mean() < 0.02


def test_latency_spike_multiplies_latency():
    _, inside, outside = run("payment-service", event("latency_spike"))
    assert inside["avg_latency"].mean() / outside["avg_latency"].mean() > 8


def test_hang_creates_timeouts_where_a_caller_has_a_timeout():
    _, inside, outside = run("payment-service", event("hang"))
    assert inside["timeout_count"].mean() > 50 and outside["timeout_count"].mean() < 1


def test_hang_on_the_gateway_raises_latency_but_not_the_timeout_feature():
    _, inside, outside = run("api-gateway", event("hang", service="api-gateway"))
    assert (inside["timeout_count"] == 0).all()
    assert inside["avg_latency"].mean() / outside["avg_latency"].mean() > 5


def test_traffic_surge_and_drop_change_the_request_rate():
    _, surge, base = run("auth-service", event("traffic_surge", service="auth-service"))
    assert surge["request_rate"].mean() / base["request_rate"].mean() > 5
    _, drop, base = run("auth-service", event("traffic_drop", service="auth-service"))
    assert drop["request_rate"].mean() / base["request_rate"].mean() < 0.1


def test_retries_amplify_the_request_rate_only_where_callers_retry():
    n = 220
    mods = Modifiers.neutral(n)
    mods.error_extra[100:160] = 0.5
    ratios = {}
    for service in ("payment-service", "notification-service"):
        frame = generate_service(get_profile(service), n, service_rng(7, service), 0, mods)
        ratios[service] = frame["request_rate"].iloc[100:160].mean() / frame["request_rate"].iloc[40:100].mean()
    assert 1.5 < ratios["payment-service"] < 2.1  # about 1 + 0.5 + 0.25 with two retries
    assert 0.9 < ratios["notification-service"] < 1.2  # best effort, no retries


def test_timeouts_are_derived_from_latency_not_drawn_independently():
    n = 220
    mods = Modifiers.neutral(n)
    mods.latency_mult[100:160] = 1000.0  # every attempt takes seconds, longer than the 1.5 s timeout
    frame = generate_service(get_profile("payment-service"), n, service_rng(7, "payment-service"), 0, mods)
    inside, outside = frame.iloc[100:160], frame.iloc[40:100]
    assert (inside["timeout_count"] >= 0.95 * inside["request_rate"] * 30).all()
    assert outside["timeout_count"].max() <= 3


def test_ramps_grow_gradually_while_steps_are_immediate():
    ramped = event("latency_spike", ramp=6, start=100, end=120)
    frame, inside, _ = run("payment-service", ramped)
    first, late = inside["avg_latency"].iloc[0], inside["avg_latency"].iloc[8:].mean()
    assert first < 0.3 * late
    assert inside["fault_progress"].iloc[0] < inside["fault_progress"].iloc[-1] == 1.0
    stepped = event("latency_spike", ramp=0, start=100, end=120)
    _, inside, _ = run("payment-service", stepped)
    assert (inside["fault_progress"] == 1.0).all()


def test_mild_faults_have_a_smaller_effect_than_strong_ones():
    _, mild, _ = run("payment-service", event("error_burst", intensity=0.0))
    _, strong, _ = run("payment-service", event("error_burst", intensity=1.0))
    assert mild["error_rate"].mean() < 0.05 < strong["error_rate"].mean()
    assert (mild["label"] == 1).all(), "mild fault windows are still labelled positive"
