"""Tests for the per-service Isolation Forest: training rules, calibration, explanation, persistence."""

import json

import numpy as np
import pytest

from anomaly_engine.dataset import SMALL_CONFIG
from anomaly_engine.features import FEATURE_NAMES, SERVICES, feature_matrix
from anomaly_engine.isolation_model import (
    IsolationForestDetector,
    ModelCompatibilityError,
    ModelIntegrityError,
    ModelLoadError,
)
from anomaly_engine.train import train

SERVICE = "payment-service"


def median_row(detector, service=SERVICE):
    return np.array(detector.train_median_raw[service])


EXTREME = [40.0, 0.5, 2.0, 6.0, 80.0]  # request_rate, error_rate, avg_latency, p95_latency, timeout_count


def test_training_rejects_windows_that_contain_faults(small_dataset):
    frame = small_dataset.segment("test")
    frame = frame[frame["service"] == SERVICE]
    assert frame["label"].any()
    with pytest.raises(ValueError, match="only normal"):
        IsolationForestDetector().fit({SERVICE: frame})


def test_training_rejects_unknown_services_and_tiny_inputs(small_dataset):
    train_frame = small_dataset.segment("train")
    with pytest.raises(ValueError):
        IsolationForestDetector().fit({"nope": train_frame})
    with pytest.raises(ValueError, match="at least 100"):
        IsolationForestDetector().fit({SERVICE: train_frame[train_frame["service"] == SERVICE].head(20)})


def test_one_forest_per_service_and_contamination_is_not_used(small_detector):
    assert set(small_detector.services) == set(SERVICES)
    for forest in small_detector.forests.values():
        assert forest.contamination == "auto"
    assert set(small_detector.thresholds) == set(SERVICES)


def test_scores_and_thresholds_are_reproducible(small_dataset, small_detector):
    again = train(3, SMALL_CONFIG, 0.01)
    rows = feature_matrix(small_dataset.segment("test").query("service == @SERVICE"))
    np.testing.assert_array_equal(small_detector.score(SERVICE, rows), again.score(SERVICE, rows))
    assert small_detector.thresholds == again.thresholds
    other = train(4, SMALL_CONFIG, 0.01)
    assert not np.array_equal(small_detector.score(SERVICE, rows), other.score(SERVICE, rows))


def test_an_extreme_window_scores_higher_than_a_typical_one(small_detector):
    typical = small_detector.score(SERVICE, median_row(small_detector))[0]
    extreme = small_detector.score(SERVICE, EXTREME)[0]
    assert extreme > typical
    assert extreme > small_detector.thresholds[SERVICE] > typical


def test_calibration_keeps_normal_alerts_within_the_target(small_dataset, small_detector):
    for service in SERVICES:
        frame = small_dataset.segment("calibration").query("service == @service")
        _, flags = small_detector.predict(service, feature_matrix(frame))
        assert flags.mean() <= 0.01


def test_calibration_rejects_fault_windows(small_dataset):
    detector = IsolationForestDetector()
    train_frame = small_dataset.segment("train")
    detector.fit({SERVICE: train_frame[train_frame["service"] == SERVICE]})
    faulty = small_dataset.segment("test").query("service == @SERVICE")
    with pytest.raises(ValueError, match="only normal"):
        detector.calibrate({SERVICE: faulty}, 0.01)


def test_predict_requires_a_threshold_and_a_known_service(small_dataset):
    detector = IsolationForestDetector()
    train_frame = small_dataset.segment("train")
    detector.fit({SERVICE: train_frame[train_frame["service"] == SERVICE]})
    with pytest.raises(RuntimeError):
        detector.predict(SERVICE, [EXTREME])
    with pytest.raises(KeyError):
        detector.score("auth-service", [EXTREME])


def test_explanations_point_at_the_feature_that_changed(small_detector):
    row = median_row(small_detector).copy()
    row[FEATURE_NAMES.index("error_rate")] = 0.6
    ranked = small_detector.explain(SERVICE, row)
    assert ranked[0]["feature"] == "error_rate" and ranked[0]["direction"] == "above"
    assert [r["contribution"] for r in ranked] == sorted((r["contribution"] for r in ranked), reverse=True)
    assert {r["feature"] for r in ranked} == set(FEATURE_NAMES)
    untouched = [r for r in ranked if r["feature"] != "error_rate"]
    assert all(r["direction"] == "same" and abs(r["contribution"]) < 1e-9 for r in untouched)


def test_save_and_load_round_trip(tmp_path, small_dataset, small_detector):
    small_detector.save(tmp_path)
    loaded = IsolationForestDetector.load(tmp_path)
    rows = feature_matrix(small_dataset.segment("test").query("service == @SERVICE"))
    np.testing.assert_array_equal(small_detector.score(SERVICE, rows), loaded.score(SERVICE, rows))
    assert loaded.thresholds == small_detector.thresholds
    assert loaded.train_median_raw == small_detector.train_median_raw
    meta = json.loads((tmp_path / "metadata.json").read_text())
    assert meta["feature_names"] == list(FEATURE_NAMES) and meta["target_fpr"] == 0.01
    assert meta["trained_with"]["scikit_learn"] and meta["training"]["data_source"] == "synthetic"
    assert len(meta["model_sha256"]) == 64


def test_saving_requires_calibration(tmp_path, small_dataset):
    detector = IsolationForestDetector()
    train_frame = small_dataset.segment("train")
    detector.fit({SERVICE: train_frame[train_frame["service"] == SERVICE]})
    with pytest.raises(RuntimeError):
        detector.save(tmp_path)


def test_a_modified_model_file_fails_the_checksum(tmp_path, small_detector):
    small_detector.save(tmp_path)
    model = tmp_path / "model.joblib"
    model.write_bytes(model.read_bytes() + b"x")
    with pytest.raises(ModelIntegrityError):
        IsolationForestDetector.load(tmp_path)


def test_a_different_scikit_learn_version_is_refused(tmp_path, small_detector):
    small_detector.save(tmp_path)
    meta_path = tmp_path / "metadata.json"
    meta = json.loads(meta_path.read_text())
    meta["trained_with"]["scikit_learn"] = "0.0.1"
    meta_path.write_text(json.dumps(meta))
    with pytest.raises(ModelCompatibilityError, match="retrain"):
        IsolationForestDetector.load(tmp_path)


def test_a_changed_feature_order_is_refused(tmp_path, small_detector):
    small_detector.save(tmp_path)
    meta_path = tmp_path / "metadata.json"
    meta = json.loads(meta_path.read_text())
    meta["feature_names"] = list(reversed(meta["feature_names"]))
    meta_path.write_text(json.dumps(meta))
    with pytest.raises(ModelCompatibilityError):
        IsolationForestDetector.load(tmp_path)


def test_missing_or_corrupt_artifacts_raise_model_load_error(tmp_path, small_detector):
    with pytest.raises(ModelLoadError, match="no model artifact"):
        IsolationForestDetector.load(tmp_path / "missing")
    small_detector.save(tmp_path)
    (tmp_path / "metadata.json").write_text("{not json")
    with pytest.raises(ModelLoadError, match="not valid JSON"):
        IsolationForestDetector.load(tmp_path)
