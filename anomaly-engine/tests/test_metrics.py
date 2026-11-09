"""Tests for the evaluation metrics, checked against hand-calculated values."""

import math

import numpy as np
import pytest

from anomaly_engine.faults import FaultEvent
from anomaly_engine.metrics import event_results, paired_interval, verdict, window_metrics


def test_window_metrics_match_a_hand_calculation():
    truth = [1, 1, 1, 1, 0, 0, 0, 0, 0, 0]
    alert = [1, 1, 1, 0, 1, 0, 0, 0, 0, 0]
    m = window_metrics(truth, alert)
    assert (m["tp"], m["fp"], m["fn"], m["tn"]) == (3, 1, 1, 5)
    assert m["precision"] == pytest.approx(0.75) and m["recall"] == pytest.approx(0.75)
    assert m["f1"] == pytest.approx(0.75) and m["fpr"] == pytest.approx(1 / 6)


def test_window_metrics_handle_degenerate_cases():
    none = window_metrics([0, 0, 0], [0, 0, 0])
    assert math.isnan(none["precision"]) and math.isnan(none["recall"]) and none["fpr"] == 0.0
    missed = window_metrics([1, 1, 0], [0, 0, 0])
    assert math.isnan(missed["precision"]) and missed["recall"] == 0.0 and missed["f1"] == 0.0
    with pytest.raises(ValueError):
        window_metrics([1, 0], [1])


def test_event_detection_and_delay():
    events = [
        FaultEvent(0, "a", "hang", start=10, end=20, intensity=1, ramp_windows=0),
        FaultEvent(1, "a", "hang", start=40, end=50, intensity=1, ramp_windows=0),
        FaultEvent(2, "b", "hang", start=10, end=20, intensity=1, ramp_windows=0),
    ]
    a, b = np.zeros(100, bool), np.zeros(100, bool)
    a[13] = True  # event 0 detected 3 windows after it started
    a[60] = True  # a false alarm outside any event must not count as a detection
    b[10] = True  # event 2 detected immediately
    rows = event_results(events, {"a": a, "b": b})
    assert [r["detected"] for r in rows] == [True, False, True]
    assert [r["delay_windows"] for r in rows] == [3, None, 0]
    assert [r["delay_seconds"] for r in rows] == [90, None, 0]


def test_an_alert_on_a_different_service_does_not_detect_the_event():
    events = [FaultEvent(0, "a", "hang", 10, 20, 1, 0)]
    other = np.zeros(100, bool)
    other[12] = True
    assert not event_results(events, {"a": np.zeros(100, bool), "b": other})[0]["detected"]


def test_paired_interval_matches_the_t_distribution():
    result = paired_interval([1.0, 2.0, 3.0])  # mean 2, sd 1, t(0.975, 2) = 4.302653
    half = 4.302653 / math.sqrt(3)
    assert result["mean"] == pytest.approx(2.0)
    assert (result["low"], result["high"]) == pytest.approx((2 - half, 2 + half), abs=1e-4)
    assert result["n"] == 3 and verdict(result) == "no significant difference"


def test_paired_interval_drops_nan_and_handles_tiny_samples():
    assert paired_interval([1.0, math.nan, 3.0, 2.0])["n"] == 3
    assert paired_interval([])["n"] == 0
    assert verdict(paired_interval([5.0])) == "undetermined"


def test_verdict_reports_direction_only_when_the_interval_excludes_zero():
    assert verdict(paired_interval([1.0, 1.1, 0.9, 1.0])) == "higher"
    assert verdict(paired_interval([-1.0, -1.1, -0.9, -1.0])) == "lower"
    assert verdict(paired_interval([-1.0, 1.0, -1.0, 1.0])) == "no significant difference"
