"""Rolling robust baseline: the CONTROL model the Isolation Forest has to beat.

For every window t and every feature (in the same log-transformed space the forest uses):

    median_t, MAD_t = median and median-absolute-deviation of the PREVIOUS `window` windows (t excluded)
    z_t             = |x_t - median_t| / max(1.4826 * MAD_t, floor)
    score_t         = max over the five features of z_t

* Causal: the score at t only uses windows before t (a test asserts this).
* Adaptive: the median follows slow changes such as the day/night cycle.
* Robust: median/MAD barely move when a few earlier windows were faulty.
* The ONLY fitted parameters are the per-feature scale floors, derived from the normal training
  segment as floor_fraction x std(feature). Floors stop near-constant features (e.g. timeouts that
  are almost always 0, so MAD = 0) from producing infinite z-scores.

It needs history, so it is an offline control model and is not served by the stateless API.
"""

from __future__ import annotations

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

from anomaly_engine.features import transform_features

MAD_TO_SIGMA = 1.4826  # makes MAD comparable to a standard deviation for normal data


class RollingBaselineDetector:
    def __init__(self, window: int = 120, floor_fraction: float = 0.5):
        if window < 3:
            raise ValueError("window must be at least 3")
        if floor_fraction <= 0:
            raise ValueError("floor_fraction must be positive")
        self.window = window
        self.floor_fraction = floor_fraction
        self.floors: np.ndarray | None = None

    def fit(self, train_features) -> "RollingBaselineDetector":
        """Derive per-feature scale floors from NORMAL training windows (raw features, shape (n, 5))."""
        x = transform_features(train_features)
        if len(x) < 2:
            raise ValueError("need at least two training windows")
        self.floors = self.floor_fraction * np.maximum(x.std(axis=0), 1e-3)
        return self

    def feature_scores(self, features) -> np.ndarray:
        """Robust z-score per window and feature, shape (T, 5). NaN for the first `window` windows."""
        if self.floors is None:
            raise RuntimeError("call fit() first")
        x = transform_features(features)
        n = len(x)
        z = np.full(x.shape, np.nan)
        if n <= self.window:
            return z
        history = sliding_window_view(x, self.window, axis=0)[:-1]  # rows: windows [t-W, t-1] for t = W..n-1
        median = np.median(history, axis=-1)
        mad = np.median(np.abs(history - median[..., None]), axis=-1)
        scale = np.maximum(MAD_TO_SIGMA * mad, self.floors)
        z[self.window :] = np.abs(x[self.window :] - median) / scale
        return z

    def score(self, features) -> np.ndarray:
        """Anomaly score per window: the largest feature z-score (NaN while history is too short)."""
        return self.feature_scores(features).max(axis=1)