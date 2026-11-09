"""Tests for the feature schema, histogram_quantile (PromQL semantics) and the transform."""

import math

import numpy as np
import pytest

from anomaly_engine.features import (
    BUCKET_BOUNDS_SECONDS,
    FEATURE_NAMES,
    cumulative_bucket_counts,
    histogram_quantile,
    transform_features,
)

BOUNDS = (1.0, 2.0, 5.0)


def test_feature_names_are_exactly_the_five_phase2_features():
    assert FEATURE_NAMES == ("request_rate", "error_rate", "avg_latency", "p95_latency", "timeout_count")


def test_quantile_interpolates_linearly_inside_the_bucket():
    counts = [10, 20, 40, 40]  # le=1: 10, le=2: 20, le=5: 40, +Inf: 40
    assert histogram_quantile(0.5, counts, BOUNDS) == pytest.approx(2.0)  # rank 20 ends bucket (1, 2]
    assert histogram_quantile(0.25, counts, BOUNDS) == pytest.approx(1.0)  # rank 10 ends bucket (0, 1]
    assert histogram_quantile(0.95, counts, BOUNDS) == pytest.approx(4.7)  # 2 + 3 * (18 / 20)
    assert histogram_quantile(0.15, counts, BOUNDS) == pytest.approx(0.6)  # 0 + 1 * (6 / 10)


def test_quantile_in_the_inf_bucket_returns_the_highest_finite_bound():
    assert histogram_quantile(0.5, [0, 0, 0, 10], BOUNDS) == 5.0


def test_quantile_without_observations_is_nan():
    assert math.isnan(histogram_quantile(0.95, [0, 0, 0, 0], BOUNDS))


def test_quantile_outside_zero_one_follows_promql():
    counts = [1, 2, 3, 3]
    assert histogram_quantile(1.5, counts, BOUNDS) == math.inf
    assert histogram_quantile(-0.1, counts, BOUNDS) == -math.inf
    assert math.isnan(histogram_quantile(math.nan, counts, BOUNDS))


def test_non_monotonic_counts_are_repaired_like_prometheus():
    # [10, 5, 20, 20] is treated as [10, 10, 20, 20]
    assert histogram_quantile(0.5, [10, 5, 20, 20], BOUNDS) == pytest.approx(1.0)


def test_rows_are_computed_independently_and_match_the_scalar_version():
    rows = np.array([[10, 20, 40, 40], [0, 0, 0, 10], [0, 0, 0, 0], [5, 5, 5, 5]])
    vector = histogram_quantile(0.9, rows, BOUNDS)
    for row, value in zip(rows, vector):
        expected = histogram_quantile(0.9, row, BOUNDS)
        assert (math.isnan(value) and math.isnan(expected)) or value == pytest.approx(expected)


def test_wrong_number_of_buckets_is_rejected():
    with pytest.raises(ValueError):
        histogram_quantile(0.5, [1, 2, 3], BOUNDS)


def test_cumulative_counts_use_le_semantics():
    cumulative = cumulative_bucket_counts([0.004, 0.005, 0.006, 20.0])
    assert cumulative[0] == 2  # 0.004 and 0.005 are <= 0.005
    assert cumulative[1] == 3  # plus 0.006 (<= 0.01)
    assert cumulative[-2] == 3  # 20 s exceeds the highest finite bound (15 s)
    assert cumulative[-1] == 4  # +Inf bucket = every observation


def test_p95_from_buckets_is_close_to_the_true_quantile():
    samples = np.random.default_rng(1).lognormal(mean=math.log(0.05), sigma=0.3, size=50_000)
    estimate = histogram_quantile(0.95, cumulative_bucket_counts(samples))
    assert estimate == pytest.approx(np.quantile(samples, 0.95), abs=0.025)  # bucket (0.05, 0.1] is 0.05 wide


def test_transform_matches_the_documented_formulas():
    out = transform_features([[10.0, 0.01, 0.05, 0.1, 2.0]])
    expected = [math.log1p(10), math.log1p(1.0), math.log1p(50.0), math.log1p(100.0), math.log1p(2.0)]
    assert out.shape == (1, 5)
    assert out[0] == pytest.approx(expected)


def test_transform_accepts_a_single_row_vector():
    assert transform_features([1, 0, 0, 0, 0]).shape == (1, 5)


@pytest.mark.parametrize(
    "bad",
    [[[1, 2, 3]], [[-1, 0, 0, 0, 0]], [[math.nan, 0, 0, 0, 0]], [[math.inf, 0, 0, 0, 0]]],
)
def test_transform_rejects_invalid_input(bad):
    with pytest.raises(ValueError):
        transform_features(bad)


def test_bucket_bounds_are_sorted_and_positive():
    assert list(BUCKET_BOUNDS_SECONDS) == sorted(BUCKET_BOUNDS_SECONDS)
    assert all(b > 0 for b in BUCKET_BOUNDS_SECONDS)
