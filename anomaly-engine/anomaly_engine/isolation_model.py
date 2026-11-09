"""Isolation Forest anomaly detector: one forest per service.

* Trained ONLY on normal training windows (a guard rejects frames that contain fault labels).
* Features are log-transformed first (features.transform_features).
* `contamination` is left at "auto" and never used: alert thresholds are calibrated on a separate
  held-out normal segment (calibration.py), at a target false-positive rate.
* Anomaly score = -score_samples(x): the original paper's score, roughly 0.5 for typical points and
  approaching 1 for clear anomalies. Higher means more anomalous.
* Explanations are counterfactual: replace one feature by the service's training median and see
  how much the score drops. It is a heuristic attribution, not a Shapley value.

Artifacts: <dir>/model.joblib (the forests) + <dir>/metadata.json (thresholds, medians, feature
order, library versions, SHA-256 of the model file). SECURITY: joblib files are pickles, so only
load artifacts you produced yourself; the checksum detects corruption, not a malicious editor who
can also rewrite the metadata.
"""

from __future__ import annotations

import hashlib
import json
import platform
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import scipy
import sklearn
from sklearn.ensemble import IsolationForest

from anomaly_engine.calibration import alerts, calibrate_threshold
from anomaly_engine.features import FEATURE_NAMES, SERVICES, WINDOW_SECONDS, feature_matrix, transform_features

SCHEMA_VERSION = 1
MODEL_FILE = "model.joblib"
METADATA_FILE = "metadata.json"
DEFAULT_N_ESTIMATORS = 200


class ModelLoadError(RuntimeError):
    """The model artifact could not be loaded."""


class ModelIntegrityError(ModelLoadError):
    """The model file does not match the checksum recorded in the metadata."""


class ModelCompatibilityError(ModelLoadError):
    """The artifact was produced with an incompatible library version or schema."""


def library_versions() -> dict[str, str]:
    return {
        "python": platform.python_version(),
        "numpy": np.__version__,
        "scipy": scipy.__version__,
        "scikit_learn": sklearn.__version__,
        "joblib": joblib.__version__,
    }


def _forest_seed(seed: int, service: str) -> int:
    sequence = np.random.SeedSequence(seed, spawn_key=(2000, SERVICES.index(service)))
    return int(sequence.generate_state(1)[0])


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


class IsolationForestDetector:
    def __init__(self, n_estimators: int = DEFAULT_N_ESTIMATORS, seed: int = 0):
        self.n_estimators = n_estimators
        self.seed = seed
        self.forests: dict[str, IsolationForest] = {}
        self.train_median_raw: dict[str, list[float]] = {}
        self.thresholds: dict[str, float] = {}
        self.target_fpr: float | None = None
        self.training_windows: dict[str, int] = {}
        self.trained_with: dict[str, str] = library_versions()

    @property
    def services(self) -> list[str]:
        return list(self.forests)

    # ---------------------------------------------------------------- training
    def fit(self, train_frames: dict[str, pd.DataFrame]) -> "IsolationForestDetector":
        """Fit one forest per service on that service's NORMAL training windows."""
        for service, frame in train_frames.items():
            if service not in SERVICES:
                raise ValueError(f"unknown service '{service}'")
            if "label" in frame.columns and frame["label"].astype(bool).any():
                raise ValueError(f"{service}: training data must contain only normal windows")
            raw = feature_matrix(frame)
            if len(raw) < 100:
                raise ValueError(f"{service}: need at least 100 training windows, got {len(raw)}")
            forest = IsolationForest(
                n_estimators=self.n_estimators,
                max_samples="auto",
                contamination="auto",
                random_state=_forest_seed(self.seed, service),
                n_jobs=1,
            )
            forest.fit(transform_features(raw))
            self.forests[service] = forest
            self.train_median_raw[service] = [float(v) for v in np.median(raw, axis=0)]
            self.training_windows[service] = len(raw)
        return self

    def calibrate(self, calibration_frames: dict[str, pd.DataFrame], target_fpr: float) -> "IsolationForestDetector":
        """Set each service's alert threshold from held-out NORMAL calibration windows."""
        for service, frame in calibration_frames.items():
            self._require(service)
            if "label" in frame.columns and frame["label"].astype(bool).any():
                raise ValueError(f"{service}: calibration data must contain only normal windows")
            self.thresholds[service] = calibrate_threshold(self.score(service, feature_matrix(frame)), target_fpr)
        self.target_fpr = target_fpr
        return self

    # ---------------------------------------------------------------- scoring
    def _require(self, service: str) -> None:
        if service not in self.forests:
            raise KeyError(service)

    def score(self, service: str, raw_features) -> np.ndarray:
        """Anomaly scores (higher = more anomalous) for raw feature rows of shape (n, 5)."""
        self._require(service)
        return -self.forests[service].score_samples(transform_features(raw_features))

    def predict(self, service: str, raw_features) -> tuple[np.ndarray, np.ndarray]:
        """(scores, alert flags). Requires calibrate() or a loaded artifact."""
        if service not in self.thresholds:
            raise RuntimeError(f"{service}: no calibrated threshold")
        scores = self.score(service, raw_features)
        return scores, alerts(scores, self.thresholds[service])

    def explain(self, service: str, raw_row) -> list[dict]:
        """Features ranked by how much replacing them with the training median lowers the score."""
        row = np.asarray(raw_row, dtype=float).reshape(-1)
        median = np.asarray(self.train_median_raw[service], dtype=float)
        base = float(self.score(service, row)[0])
        out = []
        for j, name in enumerate(FEATURE_NAMES):
            counterfactual = row.copy()
            counterfactual[j] = median[j]
            contribution = base - float(self.score(service, counterfactual)[0])
            direction = "above" if row[j] > median[j] else "below" if row[j] < median[j] else "same"
            out.append(
                {
                    "feature": name,
                    "value": float(row[j]),
                    "baseline": float(median[j]),
                    "direction": direction,
                    "contribution": round(contribution, 6),
                }
            )
        return sorted(out, key=lambda item: item["contribution"], reverse=True)

    # ---------------------------------------------------------------- persistence
    def metadata(self) -> dict:
        return {
            "schema_version": SCHEMA_VERSION,
            "model_type": "isolation_forest",
            "feature_names": list(FEATURE_NAMES),
            "window_seconds": WINDOW_SECONDS,
            "services": self.services,
            "target_fpr": self.target_fpr,
            "alert_rule": "anomaly_score > threshold",
            "thresholds": self.thresholds,
            "train_median_raw": self.train_median_raw,
            "training": {
                "seed": self.seed,
                "windows_per_service": self.training_windows,
                "n_estimators": self.n_estimators,
                "max_samples": "auto",
                "contamination": "auto (unused; thresholds are calibrated on held-out normal data)",
                "data_source": "synthetic",
            },
            "trained_with": self.trained_with,
        }

    def save(self, directory) -> Path:
        if set(self.thresholds) != set(self.forests):
            raise RuntimeError("calibrate() every service before saving")
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True)
        model_path = directory / MODEL_FILE
        joblib.dump({"forests": self.forests}, model_path)
        metadata = self.metadata()
        metadata["model_file"] = MODEL_FILE
        metadata["model_sha256"] = _sha256(model_path)
        (directory / METADATA_FILE).write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        return directory

    @classmethod
    def load(cls, directory) -> "IsolationForestDetector":
        directory = Path(directory)
        meta_path, model_path = directory / METADATA_FILE, directory / MODEL_FILE
        if not meta_path.is_file() or not model_path.is_file():
            raise ModelLoadError(f"no model artifact in {directory} (expected {METADATA_FILE} and {MODEL_FILE})")
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise ModelLoadError(f"{meta_path} is not valid JSON: {exc}") from exc

        if meta.get("schema_version") != SCHEMA_VERSION or tuple(meta.get("feature_names", ())) != FEATURE_NAMES:
            raise ModelCompatibilityError("artifact schema or feature order does not match this code; retrain the model")
        trained = meta.get("trained_with", {}).get("scikit_learn")
        if trained != sklearn.__version__:
            raise ModelCompatibilityError(
                f"model was trained with scikit-learn {trained} but {sklearn.__version__} is installed; retrain it"
            )
        if _sha256(model_path) != meta.get("model_sha256"):
            raise ModelIntegrityError("model.joblib does not match the checksum in metadata.json")

        forests = joblib.load(model_path)["forests"]
        detector = cls(n_estimators=meta["training"]["n_estimators"], seed=meta["training"]["seed"])
        detector.forests = forests
        detector.thresholds = {k: float(v) for k, v in meta["thresholds"].items()}
        detector.train_median_raw = {k: [float(x) for x in v] for k, v in meta["train_median_raw"].items()}
        detector.training_windows = meta["training"]["windows_per_service"]
        detector.target_fpr = meta["target_fpr"]
        detector.trained_with = meta["trained_with"]
        if set(detector.forests) != set(detector.thresholds):
            raise ModelCompatibilityError("forests and thresholds cover different services")
        return detector