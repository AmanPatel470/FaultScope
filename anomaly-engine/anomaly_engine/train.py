"""Train and calibrate the Isolation Forest and save the artifact used by the API.

    python -m anomaly_engine.train --seed 0 --out models/isolation_forest

Steps: generate the synthetic dataset for the seed, fit one forest per service on the NORMAL
training segment, calibrate each threshold on the NORMAL calibration segment (target FPR), save.
The test segment is never touched here, and no evaluation numbers are printed.

The demo artifact is trained on SYNTHETIC data. A real deployment must be retrained on real normal
telemetry from the monitored system.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from anomaly_engine.dataset import SMALL_CONFIG, SplitConfig, build_dataset
from anomaly_engine.isolation_model import DEFAULT_N_ESTIMATORS, IsolationForestDetector

DEFAULT_OUT = Path(__file__).resolve().parents[1] / "models" / "isolation_forest"


def train(seed: int, config: SplitConfig, target_fpr: float, n_estimators: int = DEFAULT_N_ESTIMATORS) -> IsolationForestDetector:
    dataset = build_dataset(seed, config)
    train_frames = {s: g for s, g in dataset.segment("train").groupby("service", sort=False)}
    calibration_frames = {s: g for s, g in dataset.segment("calibration").groupby("service", sort=False)}
    detector = IsolationForestDetector(n_estimators=n_estimators, seed=seed)
    detector.fit(train_frames)
    detector.calibrate(calibration_frames, target_fpr)
    return detector


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Train, calibrate and save the Isolation Forest artifact.")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--target-fpr", type=float, default=0.01)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--small", action="store_true", help="small configuration (tests only)")
    args = parser.parse_args(argv)

    detector = train(args.seed, SMALL_CONFIG if args.small else SplitConfig(), args.target_fpr)
    out = detector.save(args.out)
    print(f"Saved model artifact to {out}")
    print(f"  target FPR {args.target_fpr:.2%}; scikit-learn {detector.trained_with['scikit_learn']}")
    for service in detector.services:
        print(f"  {service:<22} windows={detector.training_windows[service]:>5}  threshold={detector.thresholds[service]:.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())