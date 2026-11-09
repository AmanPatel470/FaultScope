"""Shared fixtures: a small dataset and a detector trained on it (built once per test session)."""

import pytest

from anomaly_engine.dataset import SMALL_CONFIG, build_dataset
from anomaly_engine.train import train

SMALL_SEED = 3


@pytest.fixture(scope="session")
def small_dataset():
    return build_dataset(SMALL_SEED, SMALL_CONFIG)


@pytest.fixture(scope="session")
def small_detector():
    return train(SMALL_SEED, SMALL_CONFIG, 0.01)
