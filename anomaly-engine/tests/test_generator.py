"""Tests for the seeded NORMAL telemetry generator."""

import math

import numpy as np
import pandas as pd
import pytest

from anomaly_engine.features import FEATURE_NAMES, SERVICES, WINDOWS_PER_DAY
from anomaly_engine.generator import generate_normal, generate_service, service_rng
from anomaly_engine.profiles import PROFILES, ServiceProfile, get_profile


def test_same_seed_gives_identical_data_and_different_seed_does_not():
    a = generate_normal(5, 400)
    b = generate_normal(5, 400)
    c = generate_normal(6, 400)
    pd.testing.assert_frame_equal(a, b)
    assert not a["request_rate"].equals(c["request_rate"])


def test_each_service_has_an_independent_stream():
    full = generate_normal(5, 300)
    only_payment = generate_normal(5, 300, services=["payment-service"])
    pd.testing.assert_frame_equal(
        full[full["service"] == "payment-service"].reset_index(drop=True), only_payment
    )
    # different services get different random numbers even with the same profile shape
    a = generate_service(get_profile("auth-service"), 200, service_rng(5, "auth-service"))
    b = generate_service(get_profile("auth-service"), 200, service_rng(5, "payment-service"))
    assert not a["request_rate"].equals(b["request_rate"])


def test_schema_ranges_and_normal_labels():
    frame = generate_normal(1, 600)
    assert len(frame) == 600 * len(SERVICES)
    assert list(frame["service"].unique()) == list(SERVICES)
    for name in FEATURE_NAMES:
        assert np.isfinite(frame[name]).all() and (frame[name] >= 0).all()
    assert (frame["error_rate"] <= 1).all()
    assert (frame["label"] == 0).all() and (frame["event_id"] == -1).all() and (frame["fault_type"] == "").all()
    for _, timeline in frame.groupby("service"):
        assert list(timeline["window"]) == list(range(600))


def test_normal_statistics_match_the_profile():
    frame = generate_normal(2, 2 * WINDOWS_PER_DAY, services=["payment-service"])
    profile = PROFILES["payment-service"]
    assert frame["request_rate"].mean() == pytest.approx(profile.base_rate, rel=0.10)
    assert profile.base_error_prob / 3 < frame["error_rate"].mean() < profile.base_error_prob * 3
    expected_mean_latency = profile.latency_median_s * math.exp(profile.latency_sigma**2 / 2)
    assert frame["avg_latency"].median() == pytest.approx(expected_mean_latency, rel=0.25)
    assert frame["timeout_count"].mean() < 0.3  # timeouts are rare when nothing is wrong
    assert (frame["p95_latency"] > 0).all()


def test_request_rate_follows_a_day_night_cycle():
    day = generate_normal(2, WINDOWS_PER_DAY, services=["order-service"])
    peak = day["request_rate"].iloc[600:840].mean()  # around a quarter of the day
    trough = day["request_rate"].iloc[2040:2280].mean()  # around three quarters
    assert peak / trough > 1.5


def test_the_gateway_has_no_caller_so_its_timeout_feature_is_always_zero():
    frame = generate_normal(2, 500, services=["api-gateway"])
    assert (frame["timeout_count"] == 0).all()


def test_windows_without_traffic_produce_zeros_not_nan():
    quiet = ServiceProfile("auth-service", 0.002, 0.004, 0.4, 0.001, 2.0, 0)
    frame = generate_service(quiet, 400, np.random.default_rng(0))
    assert (frame["request_rate"] == 0).any()
    assert not frame[list(FEATURE_NAMES)].isna().any().any()
    empty = frame[frame["request_rate"] == 0]
    assert (empty[["error_rate", "avg_latency", "p95_latency"]] == 0).all().all()


def test_unknown_service_is_rejected():
    with pytest.raises(KeyError):
        get_profile("nope")
