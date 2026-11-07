"""Verify the anomaly-engine environment and show what an Isolation Forest score looks like.

Usage (from the anomaly-engine folder, venv active):  python check_environment.py
"""

import platform
import sys

import numpy as np
import pandas as pd
import sklearn
from sklearn.ensemble import IsolationForest


def main() -> int:
    print(f"python        {platform.python_version()}")
    print(f"numpy         {np.__version__}")
    print(f"pandas        {pd.__version__}")
    print(f"scikit-learn  {sklearn.__version__}")

    rng = np.random.default_rng(0)
    normal = rng.normal(loc=0.0, scale=1.0, size=(500, 1))
    probes = np.array([[0.0], [6.0]])

    def fit_and_score() -> np.ndarray:
        forest = IsolationForest(n_estimators=100, random_state=0).fit(normal)
        # score_samples returns the NEGATED anomaly score (higher = more normal), so flip the sign.
        return -forest.score_samples(probes)

    first, second = fit_and_score(), fit_and_score()
    print(f"anomaly score of a typical point (0.0): {first[0]:.3f}")
    print(f"anomaly score of an outlier      (6.0): {first[1]:.3f}")

    outlier_scores_higher = bool(first[1] > first[0])
    reproducible = bool(np.array_equal(first, second))
    print(f"outlier scores higher than typical point: {outlier_scores_higher}")
    print(f"same random_state gives identical scores: {reproducible}")

    return 0 if (outlier_scores_higher and reproducible) else 1


if __name__ == "__main__":
    sys.exit(main())