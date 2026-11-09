"""API tests (FastAPI TestClient, in-process): validation, scoring, statelessness, model loading."""

import os

os.environ["LOG_LEVEL"] = "silent"

import pytest
from fastapi.testclient import TestClient

from anomaly_engine.api import create_app
from anomaly_engine.features import FEATURE_NAMES, SERVICES
from anomaly_engine.isolation_model import ModelLoadError

SERVICE = "payment-service"
EXTREME = {"request_rate": 40.0, "error_rate": 0.5, "avg_latency": 2.0, "p95_latency": 6.0, "timeout_count": 80}


@pytest.fixture(scope="module")
def client(small_detector):
    return TestClient(create_app(detector=small_detector))


def typical(detector, service=SERVICE):
    return dict(zip(FEATURE_NAMES, detector.train_median_raw[service]))


def test_health_reports_the_loaded_model(client):
    body = client.get("/health").json()
    assert body["status"] == "ok" and body["model_loaded"] is True
    assert body["services"] == list(SERVICES) and body["target_fpr"] == 0.01
    assert client.get("/health").headers["x-request-id"]


def test_request_id_is_echoed(client):
    assert client.get("/health", headers={"x-request-id": "trace-9"}).headers["x-request-id"] == "trace-9"


def test_model_endpoint_exposes_metadata_without_the_pickle(client):
    body = client.get("/model").json()
    assert body["feature_names"] == list(FEATURE_NAMES) and set(body["thresholds"]) == set(SERVICES)
    assert len(body["train_median_raw"][SERVICE]) == 5 and body["trained_with"]["scikit_learn"]
    assert "not a failure probability" in body["interpretation"]


def test_a_typical_window_is_normal(client, small_detector):
    body = client.post("/predict", json={"service": SERVICE, "window": typical(small_detector)}).json()
    assert body["status"] == "normal" and body["is_anomalous"] is False
    assert body["anomaly_score"] <= body["threshold"] and body["margin"] <= 0
    assert body["window_seconds"] == 30


def test_an_extreme_window_is_anomalous_and_explained(client):
    body = client.post("/predict", json={"service": SERVICE, "window": EXTREME}).json()
    assert body["status"] == "anomalous" and body["is_anomalous"] is True and body["margin"] > 0
    assert len(body["top_features"]) == 3
    contributions = [f["contribution"] for f in body["top_features"]]
    assert contributions == sorted(contributions, reverse=True) and contributions[0] > 0
    assert {"feature", "value", "baseline", "direction", "contribution"} <= set(body["top_features"][0])
    assert "not a failure probability" in body["interpretation"]


def test_explanations_can_be_switched_off(client):
    body = client.post("/predict", json={"service": SERVICE, "window": EXTREME, "explain": False}).json()
    assert body["top_features"] == []


def test_every_service_has_its_own_model_and_threshold(client):
    thresholds = {s: client.post("/predict", json={"service": s, "window": EXTREME}).json()["threshold"] for s in SERVICES}
    assert len(set(thresholds.values())) > 1


def test_scoring_is_stateless(client, small_detector):
    request = {"service": SERVICE, "window": EXTREME}
    first = client.post("/predict", json=request).json()
    client.post("/predict", json={"service": "auth-service", "window": typical(small_detector, "auth-service")})
    client.post("/predict", json={"service": SERVICE, "window": typical(small_detector)})
    assert client.post("/predict", json=request).json() == first


def test_unknown_service_returns_404(client):
    response = client.post("/predict", json={"service": "nope", "window": EXTREME})
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "UNKNOWN_SERVICE" and "nope" in response.json()["error"]["message"]


def valid(**overrides):
    return {"service": SERVICE, "window": {**EXTREME, **overrides}}


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"service": SERVICE},
        {"service": SERVICE, "window": {k: v for k, v in EXTREME.items() if k != "p95_latency"}},
        {"service": SERVICE, "window": {**EXTREME, "extra": 1}},
        {**valid(), "extra": 1},
        valid(error_rate=1.5),
        valid(request_rate=-1),
        valid(avg_latency="fast"),
        {"service": "", "window": EXTREME},
        {"service": 5, "window": EXTREME},
        {"service": SERVICE, "window": EXTREME, "explain": "maybe"},
    ],
)
def test_invalid_bodies_return_400_with_details(client, body):
    response = client.post("/predict", json=body)
    assert response.status_code == 400
    error = response.json()["error"]
    assert error["code"] == "VALIDATION_ERROR" and error["details"]


def test_nan_and_malformed_json_are_rejected(client):
    nan = '{"service": "payment-service", "window": {"request_rate": NaN, "error_rate": 0, "avg_latency": 0, "p95_latency": 0, "timeout_count": 0}}'
    assert client.post("/predict", content=nan, headers={"content-type": "application/json"}).status_code == 400
    assert client.post("/predict", content="{oops", headers={"content-type": "application/json"}).status_code == 400


def test_unknown_routes_and_wrong_methods_use_the_error_shape(client):
    assert client.get("/nope").json()["error"]["code"] == "NOT_FOUND"
    response = client.get("/predict")
    assert response.status_code == 405 and response.json()["error"]["code"] == "METHOD_NOT_ALLOWED"


def test_the_api_loads_a_saved_artifact_and_scores_identically(tmp_path, small_detector):
    small_detector.save(tmp_path)
    loaded = TestClient(create_app(model_dir=tmp_path))
    memory = TestClient(create_app(detector=small_detector))
    request = {"service": SERVICE, "window": EXTREME}
    assert loaded.post("/predict", json=request).json() == memory.post("/predict", json=request).json()


def test_startup_fails_fast_when_the_model_cannot_be_loaded(tmp_path):
    with pytest.raises(ModelLoadError):
        create_app(model_dir=tmp_path / "missing")
