"""Smoke tests: the package imports and Isolation Forest behaves as the rest of Phase 4 assumes."""

import numpy as np
from sklearn.ensemble import IsolationForest

import anomaly_engine


def test_package_is_importable():
    assert anomaly_engine.__doc__


def test_isolation_forest_is_reproducible_and_ranks_outliers_higher():
    rng = np.random.default_rng(0)
    normal = rng.normal(size=(500, 1))
    probes = np.array([[0.0], [6.0]])

    runs = [-IsolationForest(n_estimators=100, random_state=0).fit(normal).score_samples(probes) for _ in range(2)]

    assert np.array_equal(runs[0], runs[1]), "same random_state must give identical scores"
    assert runs[0][1] > runs[0][0], "an outlier must get a higher anomaly score than a typical point"