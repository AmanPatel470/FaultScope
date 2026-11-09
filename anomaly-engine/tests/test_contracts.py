
"""Contract tests: the anomaly engine must agree with the Phase 1/2 files it was built from.

If someone changes a histogram boundary, a metric name, a timeout or a retry setting in the services,
these tests fail so that the generator, profiles and PromQL features are updated together.
"""

import re
from pathlib import Path

from anomaly_engine.features import BUCKET_BOUNDS_SECONDS, SERVICES
from anomaly_engine.profiles import PROFILES

ROOT = Path(__file__).resolve().parents[2]


def read(relative: str) -> str:
    path = ROOT / relative
    assert path.is_file(), f"expected Phase 1/2 file not found: {path}"
    return path.read_text(encoding="utf-8")


def numbers_in(text: str, pattern: str) -> tuple[float, ...]:
    match = re.search(pattern, text, re.S)
    assert match, f"pattern not found: {pattern}"
    return tuple(
        float(x)
        for x in match.group(1).replace("\n", " ").split(",")
        if x.strip()
    )


def env(relative: str) -> dict[str, str]:
    pairs = (
        line.split("=", 1)
        for line in read(relative).splitlines()
        if "=" in line and not line.lstrip().startswith("#")
    )
    return {k.strip(): v.strip() for k, v in pairs}


def test_server_histogram_bounds_match_phase2_in_every_service():
    for service in SERVICES:
        text = read(f"services/{service}/src/middleware/metrics.js")
        assert (
            numbers_in(text, r"BUCKETS_SECONDS\s*=\s*\[(.*?)\]")
            == BUCKET_BOUNDS_SECONDS
        ), service


def test_client_histogram_bounds_match_phase2():
    for service in ("order-service", "api-gateway"):
        text = read(f"services/{service}/src/httpClient.js")
        assert (
            numbers_in(text, r"BUCKETS_SECONDS\s*=\s*\[(.*?)\]")
            == BUCKET_BOUNDS_SECONDS
        ), service


def test_metric_and_label_names_behind_the_promql_features_exist():
    server = read("services/order-service/src/middleware/metrics.js")
    client = read("services/order-service/src/httpClient.js")

    # OpenTelemetry instrument names and units produce these Prometheus names:
    # http_server_request_duration_seconds
    # http_client_request_duration_seconds
    assert "'http.server.request.duration.seconds'" in server
    assert "unit: 's'" in server

    assert "'http.route'" in server
    assert "'http.response.status_code'" in server

    assert "'http.client.request.duration.seconds'" in client
    assert "unit: 's'" in client

    assert "'peer.service'" in client
    assert "outcome" in client
    assert "'timeout'" in client


def test_profiles_match_phase1_timeouts_and_retries():
    order = env("services/order-service/.env.example")
    gateway = env("services/api-gateway/.env.example")

    downstream = int(order["REQUEST_TIMEOUT_MS"]) / 1000
    retries = int(order["MAX_RETRIES"])

    assert (
        PROFILES["payment-service"].timeout_s == downstream
        and PROFILES["payment-service"].retries == retries
    )
    assert (
        PROFILES["inventory-service"].timeout_s == downstream
        and PROFILES["inventory-service"].retries == retries
    )
    assert (
        PROFILES["notification-service"].timeout_s
        == int(order["NOTIFICATION_TIMEOUT_MS"]) / 1000
    )
    assert PROFILES["notification-service"].retries == 0

    assert (
        PROFILES["auth-service"].timeout_s
        == int(gateway["REQUEST_TIMEOUT_MS"]) / 1000
    )
    assert (
        PROFILES["order-service"].timeout_s
        == int(gateway["ORDER_TIMEOUT_MS"]) / 1000
    )
    assert PROFILES["auth-service"].retries == PROFILES["order-service"].retries == 0

    assert PROFILES["api-gateway"].timeout_s is None


def test_phase1_retry_behaviour_assumed_by_the_profiles_is_still_in_the_code():
    assert "maxRetries: 0" in read("services/api-gateway/src/app.js")
    assert "retries: 0" in read("services/order-service/src/dependencies.js")


def test_prometheus_scrapes_every_service_under_its_own_job_name():
    prometheus = read("monitoring/prometheus.yml")

    for service in SERVICES:
        assert f"job_name: {service}" in prometheus
