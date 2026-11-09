"""Tests for the chronological split and the leakage-prevention rules."""

import numpy as np
import pandas as pd
import pytest

from anomaly_engine.dataset import SMALL_CONFIG, SplitConfig, SplitError, build_dataset, validate_split
from anomaly_engine.features import SERVICES


def test_default_split_sizes_follow_the_specification():
    config = SplitConfig()
    assert (config.train_windows, config.gap_windows, config.calibration_windows, config.test_windows) == (8640, 4, 2880, 2880)
    assert config.train_range == (0, 8640)
    assert config.calibration_range == (8644, 11524)
    assert config.test_range == (11528, 14408)
    assert config.total_windows == 14408


def test_full_size_dataset_has_the_specified_segments_and_only_test_faults():
    dataset = build_dataset(0)
    for service in SERVICES:
        timeline = dataset.service_timeline(service)
        seg = timeline["segment"].value_counts()
        assert (seg["train"], seg["calibration"], seg["test"], seg["gap"]) == (8640, 2880, 2880, 8)
    train, cal, test = (dataset.segment(s) for s in ("train", "calibration", "test"))
    assert (train["label"] == 0).all() and (cal["label"] == 0).all()
    assert 0.02 < test["label"].mean() < 0.10
    assert len(dataset.events) == 12 * len(SERVICES)


def test_segments_are_chronological_disjoint_and_separated_by_gaps(small_dataset):
    c = small_dataset.config
    train, cal, test = (small_dataset.segment(s) for s in ("train", "calibration", "test"))
    assert cal["window"].min() - train["window"].max() == c.gap_windows + 1
    assert test["window"].min() - cal["window"].max() == c.gap_windows + 1
    assert set(train["window"]).isdisjoint(cal["window"]) and set(cal["window"]).isdisjoint(test["window"])
    gap = small_dataset.segment("gap")["window"]
    assert set(gap).isdisjoint(set(train["window"]) | set(cal["window"]) | set(test["window"]))


def test_fault_events_exist_only_inside_the_test_segment(small_dataset):
    lo, hi = small_dataset.config.test_range
    for e in small_dataset.events:
        assert lo <= e.start < e.end <= hi
    faulty = small_dataset.frame[small_dataset.frame["label"] == 1]
    assert (faulty["segment"] == "test").all()
    assert 0.02 < small_dataset.segment("test")["label"].mean() < 0.20


def test_dataset_is_reproducible_by_seed():
    a, b, c = (build_dataset(s, SMALL_CONFIG) for s in (11, 11, 12))
    pd.testing.assert_frame_equal(a.frame, b.frame)
    assert a.events == b.events
    assert not a.frame["request_rate"].equals(c.frame["request_rate"])


@pytest.mark.parametrize(
    "corrupt",
    [
        lambda f: f.__setitem__("label", np.where(f["window"] == 100, 1, f["label"])),
        lambda f: f.__setitem__("label", np.where((f["window"] == 1300) & (f["service"] == "auth-service"), 1, f["label"])),
        lambda f: f.__setitem__("segment", np.where(f["window"] == 5, "test", f["segment"])),
    ],
    ids=["fault-in-train", "fault-in-calibration", "train-row-labelled-test"],
)
def test_validate_split_rejects_leaky_datasets(small_dataset, corrupt):
    frame = small_dataset.frame.copy()
    corrupt(frame)
    with pytest.raises(SplitError):
        validate_split(frame, small_dataset.config)


def test_validate_split_rejects_a_timeline_with_missing_windows(small_dataset):
    frame = small_dataset.frame.copy()
    frame = frame[~((frame["service"] == "auth-service") & (frame["window"] == 700))]
    with pytest.raises(SplitError):
        validate_split(frame, small_dataset.config)


def test_a_service_timeline_is_contiguous_and_sorted(small_dataset):
    for service in SERVICES:
        windows = small_dataset.service_timeline(service)["window"].to_numpy()
        assert (np.diff(windows) == 1).all() and windows[0] == 0
