"""Tests for threshold calibration shared by both detectors."""

import numpy as np
import pytest

from anomaly_engine.calibration import alerts, calibrate_threshold


@pytest.mark.parametrize("target", [0.005, 0.01, 0.02, 0.1])
def test_at_most_the_target_share_of_normal_scores_alerts(target):
    scores = np.random.default_rng(0).normal(size=2880)
    threshold = calibrate_threshold(scores, target)
    assert alerts(scores, threshold).mean() <= target
    assert alerts(scores, threshold).mean() > target / 2  # and it is not wildly conservative


def test_nan_scores_are_ignored_and_never_alert():
    scores = np.concatenate([np.full(50, np.nan), np.random.default_rng(1).normal(size=1000)])
    assert np.isfinite(calibrate_threshold(scores, 0.01))
    assert not alerts([np.nan], 0.0)[0]


def test_alert_rule_is_strictly_greater_than():
    assert list(alerts([1.0, 2.0, 3.0], 2.0)) == [False, False, True]


@pytest.mark.parametrize("target", [0, 1, -0.1, 1.5])
def test_invalid_targets_are_rejected(target):
    with pytest.raises(ValueError):
        calibrate_threshold(np.arange(1000.0), target)


def test_too_few_calibration_windows_are_rejected():
    with pytest.raises(ValueError):
        calibrate_threshold(np.arange(50.0), 0.01)
