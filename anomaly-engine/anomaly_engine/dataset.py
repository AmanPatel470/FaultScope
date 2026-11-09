"""Chronological dataset: one continuous timeline per service, cut into train / calibration / test.

    |<-- train (normal only) -->|gap|<-- calibration (normal only) -->|gap|<-- test (normal + faults) -->|

Rules that prevent leakage
    * segments are consecutive in time (never shuffled)
    * 4-window gaps separate segments, because neighbouring windows are near-duplicates
    * faults exist ONLY in the test segment, so train and calibration are normal by construction
    * every model is fitted on train, every threshold is set on calibration, the test segment is
      only used to measure results
    * the gap windows stay in the timeline (the rolling baseline needs recent history) but belong
      to no segment that any model is fitted or scored on

Usage (inspect a dataset):  python -m anomaly_engine.dataset --seed 0
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from anomaly_engine.faults import FaultEvent, build_modifiers, schedule_faults
from anomaly_engine.features import FEATURE_NAMES, SERVICES, WINDOW_SECONDS
from anomaly_engine.generator import generate_service, service_rng
from anomaly_engine.profiles import get_profile

FAULT_STREAM_KEY = 1000  # random stream for fault scheduling (services use keys 0..5)


@dataclass(frozen=True)
class SplitConfig:
    train_windows: int = 8640  # 3 days of 30 s windows
    gap_windows: int = 4
    calibration_windows: int = 2880  # 1 day
    test_windows: int = 2880  # 1 day
    events_per_service: int = 12

    @property
    def train_range(self) -> tuple[int, int]:
        return 0, self.train_windows

    @property
    def calibration_range(self) -> tuple[int, int]:
        start = self.train_windows + self.gap_windows
        return start, start + self.calibration_windows

    @property
    def test_range(self) -> tuple[int, int]:
        start = self.calibration_range[1] + self.gap_windows
        return start, start + self.test_windows

    @property
    def total_windows(self) -> int:
        return self.test_range[1]


SMALL_CONFIG = SplitConfig(train_windows=1200, calibration_windows=600, test_windows=600, events_per_service=4)


class SplitError(ValueError):
    """The dataset violates a leakage-prevention rule."""


@dataclass
class Dataset:
    seed: int
    config: SplitConfig
    frame: pd.DataFrame  # full timeline, sorted by (service order, window), with a `segment` column
    events: list[FaultEvent] = field(default_factory=list)

    def segment(self, name: str) -> pd.DataFrame:
        return self.frame[self.frame["segment"] == name]

    def service_timeline(self, service: str) -> pd.DataFrame:
        """The service's complete timeline (all segments), ordered by window."""
        return self.frame[self.frame["service"] == service].reset_index(drop=True)


def _segment_labels(windows: np.ndarray, config: SplitConfig) -> np.ndarray:
    labels = np.full(len(windows), "gap", dtype=object)
    for name, (lo, hi) in (
        ("train", config.train_range),
        ("calibration", config.calibration_range),
        ("test", config.test_range),
    ):
        labels[(windows >= lo) & (windows < hi)] = name
    return labels


def validate_split(frame: pd.DataFrame, config: SplitConfig) -> None:
    """Raise SplitError if any leakage-prevention rule is broken."""
    for service, timeline in frame.groupby("service", sort=False):
        windows = timeline["window"].to_numpy()
        if not np.all(np.diff(windows) == 1) or windows[0] != 0 or len(windows) != config.total_windows:
            raise SplitError(f"{service}: timeline must be the contiguous windows 0..{config.total_windows - 1}")

    segment_range = {
        "train": config.train_range,
        "calibration": config.calibration_range,
        "test": config.test_range,
    }
    for name, (lo, hi) in segment_range.items():
        part = frame[frame["segment"] == name]
        if part["window"].min() < lo or part["window"].max() >= hi:
            raise SplitError(f"segment '{name}' contains windows outside its range")
    if frame[frame["segment"] == "gap"]["window"].between(*config.train_range, inclusive="left").any():
        raise SplitError("gap windows overlap the training segment")

    if config.gap_windows < 1:
        raise SplitError("segments must be separated by at least one gap window")
    for name in ("train", "calibration"):
        if frame[(frame["segment"] == name) & (frame["label"] != 0)].shape[0]:
            raise SplitError(f"the {name} segment contains fault windows; it must be normal only")
    outside_test = frame[(frame["segment"] != "test") & (frame["label"] != 0)]
    if len(outside_test):
        raise SplitError("fault windows exist outside the test segment")


def build_dataset(seed: int, config: SplitConfig = SplitConfig(), services=SERVICES) -> Dataset:
    """Generate the full timeline for every service, inject faults into the test segment only."""
    ordered = sorted(services, key=SERVICES.index)
    fault_rng = np.random.default_rng(np.random.SeedSequence(seed, spawn_key=(FAULT_STREAM_KEY,)))
    test_start, _ = config.test_range
    events = schedule_faults(
        fault_rng, ordered, first_window=test_start, n_windows=config.test_windows,
        events_per_service=config.events_per_service,
    )

    frames = []
    for service in ordered:
        mods = build_modifiers(events, service, config.total_windows)
        frames.append(
            generate_service(get_profile(service), config.total_windows, service_rng(seed, service), 0, mods)
        )
    frame = pd.concat(frames, ignore_index=True)
    frame["segment"] = _segment_labels(frame["window"].to_numpy(), config)
    validate_split(frame, config)
    return Dataset(seed=seed, config=config, frame=frame, events=events)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Generate a synthetic dataset and print a summary.")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--small", action="store_true", help="use the small configuration (quick look)")
    args = parser.parse_args(argv)

    config = SMALL_CONFIG if args.small else SplitConfig()
    dataset = build_dataset(args.seed, config)
    print(f"seed {dataset.seed}: {config.total_windows} windows of {WINDOW_SECONDS}s per service, "
          f"{len(dataset.events)} fault events in the test segment")
    for name in ("train", "calibration", "test"):
        part = dataset.segment(name)
        print(f"  {name:<12} {len(part) // len(SERVICES):>6} windows/service, "
              f"{int(part['label'].sum()):>5} fault windows in total")
    print("\nmedian feature values over the training segment:")
    train = dataset.segment("train")
    print(train.groupby("service", sort=False)[list(FEATURE_NAMES)].median().round(4).to_string())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())