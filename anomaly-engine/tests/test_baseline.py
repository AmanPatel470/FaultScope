"""Tests for the rolling robust baseline (control model)."""

import numpy as np
import pytest

from anomaly_engine.baseline import RollingBaselineDetector
from anomaly_engine.dataset import SMALL_CONFIG


def normal_features(n, seed=0):
    rng = np.random.default_rng(seed)
    return np.column_stack(
        [
            rng.normal(6, 0.5, n).clip(0.1),
            rng.binomial(180, 0.003, n) / 180,
            rng.normal(0.02, 0.002, n).clip(0.001),
            rng.normal(0.05, 0.004, n).clip(0.001),
            rng.binomial(1, 0.01, n).astype(float),
        ]
    )


def fitted(window=60):
    return RollingBaselineDetector(window=window).fit(normal_features(1000, seed=1))


def test_a_spike_scores_far_above_normal_windows():
    x = normal_features(300)
    x[250, 3] = 2.0  # p95 latency jumps from 50 ms to 2 s
    score = fitted().score(x)
    assert score[250] > 5 * np.nanmedian(score[100:240])


def test_the_first_window_of_history_has_no_score():
    score = fitted(window=60).score(normal_features(200))
    assert np.isnan(score[:60]).all() and np.isfinite(score[60:]).all()
    assert np.isnan(fitted(window=60).score(normal_features(50))).all()


def test_scores_are_causal_future_data_never_changes_past_scores():
    x = normal_features(300)
    y = x.copy()
    y[200:] *= 5
    a, b = fitted().score(x), fitted().score(y)
    np.testing.assert_array_equal(a[:200], b[:200])


def test_scale_floors_come_from_training_data_only():
    train = normal_features(500, seed=1)
    first = RollingBaselineDetector().fit(train)
    second = RollingBaselineDetector().fit(train.copy())
    np.testing.assert_array_equal(first.floors, second.floors)  # same training data, same floors
    assert (first.floors > 0).all()
    scaled = RollingBaselineDetector().fit(train * np.array([3, 1, 1, 1, 1]))  # different training data
    assert scaled.floors[0] > first.floors[0]


def test_a_few_earlier_outliers_do_not_blind_the_detector():
    x = normal_features(300)
    x[130:150, 3] = 1.0  # 20 earlier faulty windows inside the 60-window history
    x[200, 3] = 3.0
    score = fitted().score(x)
    assert score[200] > 5


def test_slow_drift_is_absorbed_but_a_sudden_step_is_not():
    n = 400
    base = normal_features(n)
    drift, step = base.copy(), base.copy()
    drift[:, 0] *= np.linspace(1, 2, n)  # request rate doubles slowly
    step[300:, 0] *= 2  # request rate doubles at once
    detector = fitted()
    # look at the request-rate feature only (the overall score is a max over all five features)
    drift_z = detector.feature_scores(drift)[300:, 0]
    step_z = detector.feature_scores(step)[300:305, 0]
    assert np.nanmax(step_z) > 2 * np.nanmax(drift_z)


def test_the_detector_must_be_fitted_and_validates_parameters():
    with pytest.raises(RuntimeError):
        RollingBaselineDetector().score(normal_features(200))
    with pytest.raises(ValueError):
        RollingBaselineDetector(window=2)
    with pytest.raises(ValueError):
        RollingBaselineDetector(floor_fraction=0)


def test_scores_on_a_generated_service_are_finite_after_the_warm_up(small_dataset):
    from anomaly_engine.features import feature_matrix

    timeline = small_dataset.service_timeline("payment-service")
    raw = feature_matrix(timeline)
    train_end = SMALL_CONFIG.train_range[1]
    score = RollingBaselineDetector().fit(raw[:train_end]).score(raw)
    assert np.isnan(score[:120]).all() and np.isfinite(score[120:]).all()
