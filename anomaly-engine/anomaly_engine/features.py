"""Feature schema, Prometheus-compatible histogram_quantile, and the model-space transform.

The five features are the Phase 2 telemetry features, computed per service per 30-second
non-overlapping window (PromQL definitions: backend/src/telemetryFeatures.js):

    request_rate   requests per second (health probes excluded)
    error_rate     share of responses with a 5xx status, 0..1 (0 when there is no traffic)
    avg_latency    mean server-side request duration, seconds (0 when there is no traffic)
    p95_latency    95th percentile estimated from histogram buckets, seconds (0 when no traffic)
    timeout_count  client-observed timeouts of calls TO this service in the window

BUCKET_BOUNDS_SECONDS must equal the Phase 2 histogram boundaries
(services/*/src/middleware/metrics.js); tests/test_contracts.py enforces that.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

FEATURE_NAMES = ("request_rate", "error_rate", "avg_latency", "p95_latency", "timeout_count")
WINDOW_SECONDS = 30
WINDOWS_PER_DAY = 86400 // WINDOW_SECONDS  # 2880

BUCKET_BOUNDS_SECONDS = (0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 15.0)

SERVICES = (
    "api-gateway",
    "auth-service",
    "order-service",
    "payment-service",
    "inventory-service",
    "notification-service",
)


def cumulative_bucket_counts(latencies_seconds, bounds=BUCKET_BOUNDS_SECONDS) -> np.ndarray:
    """Cumulative histogram counts (Prometheus `le` semantics: a value <= bound falls in that bucket).

    Returns len(bounds) + 1 counts; the last one is the +Inf bucket (= total observations).
    """
    values = np.asarray(latencies_seconds, dtype=float)
    index = np.searchsorted(np.asarray(bounds, dtype=float), values, side="left")
    return np.cumsum(np.bincount(index, minlength=len(bounds) + 1))


def histogram_quantile(q: float, cumulative_counts, bounds=BUCKET_BOUNDS_SECONDS):
    """Estimate a quantile from cumulative bucket counts, exactly like PromQL's histogram_quantile.

    - Linear interpolation inside the bucket that contains the target rank.
    - If the rank falls in the +Inf bucket, the highest finite bound is returned.
    - NaN when there are no observations; -Inf for q < 0; +Inf for q > 1.
    - Non-monotonic counts are repaired (running maximum), as Prometheus does.

    Accepts a 1-D array (returns a float) or a 2-D array of shape (n, len(bounds)+1) (returns n values).
    """
    bounds_arr = np.asarray(bounds, dtype=float)
    counts = np.asarray(cumulative_counts, dtype=float)
    scalar_input = counts.ndim == 1
    counts = np.atleast_2d(counts)
    n_bounds = bounds_arr.size
    if counts.shape[1] != n_bounds + 1:
        raise ValueError(f"expected {n_bounds + 1} cumulative counts per histogram, got {counts.shape[1]}")

    rows = counts.shape[0]
    if np.isnan(q):
        out = np.full(rows, np.nan)
    elif q < 0:
        out = np.full(rows, -np.inf)
    elif q > 1:
        out = np.full(rows, np.inf)
    else:
        counts = np.maximum.accumulate(counts, axis=1)
        total = counts[:, -1]
        rank = q * total
        bucket = (counts < rank[:, None]).sum(axis=1)  # first bucket whose cumulative count >= rank
        out = np.full(rows, np.nan)
        has_data = total > 0
        in_inf_bucket = has_data & (bucket >= n_bounds)
        out[in_inf_bucket] = bounds_arr[-1]

        finite = np.flatnonzero(has_data & ~in_inf_bucket)
        b = bucket[finite]
        before = np.maximum(b - 1, 0)
        prev_count = np.where(b > 0, counts[finite, before], 0.0)
        start = np.where(b > 0, bounds_arr[before], 0.0)
        end = bounds_arr[b]
        in_bucket = counts[finite, b] - prev_count
        rank_in_bucket = rank[finite] - prev_count
        fraction = np.divide(rank_in_bucket, in_bucket, out=np.zeros_like(rank_in_bucket), where=in_bucket > 0)
        out[finite] = start + (end - start) * fraction

    return float(out[0]) if scalar_input else out


def feature_matrix(frame: pd.DataFrame) -> np.ndarray:
    """(n, 5) float array in FEATURE_NAMES order from a DataFrame that has the five feature columns."""
    missing = [name for name in FEATURE_NAMES if name not in frame.columns]
    if missing:
        raise ValueError(f"missing feature columns: {missing}")
    return frame.loc[:, list(FEATURE_NAMES)].to_numpy(dtype=float)


def transform_features(values) -> np.ndarray:
    """Raw features -> model space. Parameter-free, so it cannot leak information from any dataset.

        request_rate   log1p(req/s)
        error_rate     log1p(100 * ratio)   i.e. log of percent
        avg_latency    log1p(milliseconds)
        p95_latency    log1p(milliseconds)
        timeout_count  log1p(count)

    Why log: Isolation Forest picks split values uniformly between a feature's min and max, so a
    heavy-tailed feature (latency) would otherwise be dominated by its few huge values.
    """
    x = np.asarray(values, dtype=float)
    if x.ndim == 1:
        x = x[None, :]
    if x.ndim != 2 or x.shape[1] != len(FEATURE_NAMES):
        raise ValueError(f"expected shape (n, {len(FEATURE_NAMES)}), got {x.shape}")
    if not np.all(np.isfinite(x)) or np.any(x < 0):
        raise ValueError("features must be finite and non-negative")
    out = np.empty_like(x)
    out[:, 0] = np.log1p(x[:, 0])
    out[:, 1] = np.log1p(100.0 * x[:, 1])
    out[:, 2] = np.log1p(1000.0 * x[:, 2])
    out[:, 3] = np.log1p(1000.0 * x[:, 3])
    out[:, 4] = np.log1p(x[:, 4])
    return out