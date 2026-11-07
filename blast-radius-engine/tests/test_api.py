"""API tests (FastAPI TestClient, in-process)."""

import os

os.environ["LOG_LEVEL"] = "silent"

import pytest
from fastapi.testclient import TestClient

from blast_radius.api import create_app
from blast_radius.graph_builder import build_graph


@pytest.fixture(scope="module")
def client():
    return TestClient(create_app())


def test_health_reports_graph_size_and_request_id(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {
        "service": "blast-radius-engine",
        "status": "ok",
        "services": 6,
        "dependencies": 5,
    }
    assert response.headers["x-request-id"]


def test_request_id_is_echoed(client):
    response = client.get("/health", headers={"x-request-id": "trace-123"})
    assert response.headers["x-request-id"] == "trace-123"


def test_graph_endpoint_exposes_nodes_edges_and_direction(client):
    body = client.get("/graph").json()
    assert "depends on" in body["semantics"]
    assert len(body["nodes"]) == 6
    assert len(body["edges"]) == 5
    assert {
        "service": "order-service",
        "depends_on": "payment-service",
        "dependency": "hard",
        "strength": 1.0,
    } in body["edges"]
    assert {edge["dependency"] for edge in body["edges"]} == {"hard", "soft"}


def test_analyze_payment_failure(client):
    response = client.post("/analyze", json={"failed_service": "payment-service"})
    assert response.status_code == 200
    body = response.json()
    assert body["failed_service"] == "payment-service"
    assert body["direct_dependents"] == ["order-service"]
    assert body["indirect_dependents"] == ["api-gateway"]
    assert body["unaffected"] == ["auth-service", "inventory-service", "notification-service"]
    assert body["affected"][0]["paths"] == [["order-service", "payment-service"]]
    assert body["impact"]["severity"] == "HIGH"
    assert body["impact"]["score"] == pytest.approx(59.6, abs=0.05)
    assert body["impact"]["scoring_model"] == "heuristic-v1"
    assert "not a calibrated" in body["impact"]["interpretation"]
    assert body["impact"]["contributions"][0]["role"] == "failed"


def test_analyze_notification_failure_is_soft_and_low(client):
    body = client.post("/analyze", json={"failed_service": "notification-service"}).json()
    assert [(a["service"], a["exposure"]) for a in body["affected"]] == [
        ("order-service", "soft"),
        ("api-gateway", "soft"),
    ]
    assert body["impact"]["severity"] == "LOW"


def test_analyze_gateway_failure_is_critical_and_strands_services(client):
    body = client.post("/analyze", json={"failed_service": "api-gateway"}).json()
    assert body["affected"] == []
    assert body["impact"]["severity"] == "CRITICAL"
    roles = {part["role"] for part in body["impact"]["contributions"]}
    assert roles == {"failed", "stranded"}


def test_unknown_service_returns_404(client):
    response = client.post("/analyze", json={"failed_service": "nope"})
    assert response.status_code == 404
    error = response.json()["error"]
    assert error["code"] == "UNKNOWN_SERVICE"
    assert "nope" in error["message"]


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"failed_service": ""},
        {"failed_service": 123},
        {"failed_service": "payment-service", "extra": 1},
        {"failed_service": "x" * 65},
    ],
)
def test_invalid_bodies_return_400_validation_error(client, body):
    response = client.post("/analyze", json=body)
    assert response.status_code == 400
    error = response.json()["error"]
    assert error["code"] == "VALIDATION_ERROR"
    assert error["details"]


def test_malformed_json_returns_400(client):
    response = client.post("/analyze", content="{not json", headers={"content-type": "application/json"})
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"


def test_unknown_route_returns_json_404(client):
    response = client.get("/nope")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_FOUND"


def test_wrong_method_returns_405(client):
    response = client.get("/analyze")
    assert response.status_code == 405
    assert response.json()["error"]["code"] == "METHOD_NOT_ALLOWED"


def test_app_can_be_created_with_a_custom_graph():
    graph = build_graph(
        {
            "services": [{"name": "x", "criticality": 1.0}, {"name": "y", "criticality": 0.5}],
            "dependencies": [{"service": "x", "depends_on": "y", "dependency": "hard", "strength": 1.0}],
        }
    )
    client = TestClient(create_app(graph))
    assert client.get("/health").json()["services"] == 2
    assert client.post("/analyze", json={"failed_service": "y"}).json()["direct_dependents"] == ["x"]
    assert client.post("/analyze", json={"failed_service": "payment-service"}).status_code == 404


def test_openapi_schema_documents_all_endpoints(client):
    paths = client.get("/openapi.json").json()["paths"]
    assert {"/health", "/graph", "/analyze"} <= set(paths)