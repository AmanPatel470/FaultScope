"""Alert-threshold calibration shared by BOTH detectors, so they get the same false-alarm budget.

A detector produces a continuous anomaly score; an alert is raised when `score > threshold`.
The threshold is the (1 - target_fpr) quantile of the scores the detector gives to held-out
NORMAL windows (the calibration segment). By construction at most target_fpr of those windows
alert. Test-set false-positive rates then show how well that calibration carries over.

(We deliberately do not use scikit-learn's `contamination` option: it derives the threshold from
the training data itself, which is in-sample and optimistic.)
"""

from __future__ import annotations

import math

import numpy as np


def calibrate_threshold(normal_scores, target_fpr: float) -> float:
    if not 0.0 < target_fpr < 1.0:
        raise ValueError("target_fpr must be strictly between 0 and 1")
    scores = np.asarray(normal_scores, dtype=float)
    scores = scores[~np.isnan(scores)]
    needed = math.ceil(1.0 / target_fpr)
    if scores.size < needed:
        raise ValueError(f"need at least {needed} normal calibration windows for target_fpr={target_fpr}, got {scores.size}")
    return float(np.quantile(scores, 1.0 - target_fpr, method="higher"))


def alerts(scores, threshold: float) -> np.ndarray:
    """Boolean alert flags. NaN scores (no history yet) never alert."""
    return np.asarray(scores, dtype=float) > threshold