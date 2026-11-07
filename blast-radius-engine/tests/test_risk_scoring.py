"""Tests for heuristic impact scoring."""

import json

import pytest

from blast_radius.graph_builder import build_graph, load_graph
from blast_radius.impact_analyzer import UnknownServiceError, analyze_failure
from blast_radius.risk_scoring import (
    DEFAULT_CONFIG,
    SEVERITIES,
    ScoringConfig,
    score_failure,
    severity_for,
)

TOTAL_CRITICALITY = 4.7  # 1.0 + 0.8 + 0.9 + 1.0 + 0.7 + 0.3

ALL_SERVICES = [
    "api-gateway",
    "auth-service",
    "inventory-service",
    "notification-service",
    "order-service",
    "payment-service",
]


@pytest.fixture(scope="module")
def graph():
    return load_graph()


def by_service(result):
    return {part.service: part for part in result.contributions}


HAND_CALCULATED = [
    # service, raw impact worked out by hand from topology.json, expected severity
    ("payment-service", 2.8, "HIGH"),  # 1.0 + 0.9 (order) + 0.9 (gateway: 1.0 x 0.9)
    ("inventory-service", 2.5, "HIGH"),  # 0.7 + 0.9 + 0.9
    ("auth-service", 1.8, "MEDIUM"),  # 0.8 + 1.0 (gateway)
    ("order-service", 1.8, "MEDIUM"),  # 0.9 + 0.9 (gateway: 1.0 x 0.9)
    ("notification-service", 0.39, "LOW"),  # 0.3 + 0.045 (order) + 0.045 (gateway), both soft
    ("api-gateway", 4.1535, "CRITICAL"),  # 1.0 + 0.8 + 0.81 + 0.63 + 0.9 + 0.0135, all stranded
]


@pytest.mark.parametrize(("service", "raw", "severity"), HAND_CALCULATED)
def test_scores_and_severities_match_hand_calculation(graph, service, raw, severity):
    result = score_failure(graph, service)
    assert result.raw_impact == pytest.approx(raw)
    assert result.max_raw_impact == pytest.approx(TOTAL_CRITICALITY)
    assert result.score == pytest.approx(100 * raw / TOTAL_CRITICALITY, abs=0.05)
    assert result.severity == severity


def test_payment_breakdown_lists_every_contribution(graph):
    result = score_failure(graph, "payment-service")
    parts = by_service(result)
    assert set(parts) == {"payment-service", "order-service", "api-gateway"}
    assert result.contributions[0].service == "payment-service"
    assert parts["payment-service"].role == "failed"
    assert parts["order-service"].role == "dependent"
    assert parts["order-service"].criticality == pytest.approx(0.9)
    assert parts["order-service"].dependency_strength == pytest.approx(1.0)
    assert parts["order-service"].contribution == pytest.approx(0.9)
    # The gateway reaches Payment via gateway->order (0.9) and order->payment (1.0).
    assert parts["api-gateway"].dependency_strength == pytest.approx(0.9)
    assert parts["api-gateway"].propagation_factor == 1.0


def test_notification_contributions_use_the_soft_propagation_factor(graph):
    parts = by_service(score_failure(graph, "notification-service"))
    assert parts["order-service"].dependency_strength == pytest.approx(0.2)
    assert parts["order-service"].propagation_factor == pytest.approx(0.25)
    assert parts["order-service"].contribution == pytest.approx(0.9 * 0.2 * 0.25)
    assert parts["api-gateway"].dependency_strength == pytest.approx(0.18)  # 0.9 x 0.2
    assert parts["api-gateway"].propagation_factor == pytest.approx(0.25)


def test_gateway_failure_strands_every_service_behind_the_entry_point(graph):
    parts = by_service(score_failure(graph, "api-gateway"))
    stranded = {name for name, part in parts.items() if part.role == "stranded"}
    assert stranded == {
        "auth-service",
        "order-service",
        "inventory-service",
        "payment-service",
        "notification-service",
    }
    assert parts["api-gateway"].role == "failed"
    assert parts["order-service"].dependency_strength == pytest.approx(0.9)
    assert parts["notification-service"].propagation_factor == pytest.approx(0.25)
    assert parts["notification-service"].contribution == pytest.approx(0.0135)


def test_only_entry_points_have_stranded_services(graph):
    for service in ALL_SERVICES:
        if service == "api-gateway":
            continue
        roles = {part.role for part in score_failure(graph, service).contributions}
        assert "stranded" not in roles, service
    # Documented limitation: Payment receives no traffic if Order fails, but is not counted.
    order_roles = {part.service: part.role for part in score_failure(graph, "order-service").contributions}
    assert order_roles == {"order-service": "failed", "api-gateway": "dependent"}


def test_more_critical_failures_rank_higher(graph):
    scores = {service: score_failure(graph, service).score for service in ALL_SERVICES}
    assert (
        scores["api-gateway"]
        > scores["payment-service"]
        > scores["inventory-service"]
        > scores["auth-service"]
        > scores["notification-service"]
    )


@pytest.mark.parametrize("service", ALL_SERVICES)
def test_every_score_is_bounded_and_internally_consistent(graph, service):
    result = score_failure(graph, service)
    assert 0 < result.score <= 100
    assert result.severity in SEVERITIES
    assert result.contributions[0].role == "failed"
    assert result.raw_impact == pytest.approx(sum(part.contribution for part in result.contributions))
    for part in result.contributions:
        assert 0 < part.dependency_strength <= 1
        assert 0 < part.propagation_factor <= 1
        assert part.contribution <= part.criticality + 1e-9
    names = [part.service for part in result.contributions]
    assert len(names) == len(set(names)), "a service must be counted once"


def test_soft_propagation_setting_only_changes_soft_exposure_impact(graph):
    low = ScoringConfig(soft_propagation=0.1)
    high = ScoringConfig(soft_propagation=1.0)

    def notification(config):
        return score_failure(graph, "notification-service", config).raw_impact

    assert notification(low) == pytest.approx(0.336)  # 0.3 + 0.018 + 0.018
    assert notification(DEFAULT_CONFIG) == pytest.approx(0.39)
    assert notification(high) == pytest.approx(0.66)  # 0.3 + 0.18 + 0.18

    # Payment has hard exposure only, so the soft factor must not matter.
    payment_low = score_failure(graph, "payment-service", low).raw_impact
    payment_high = score_failure(graph, "payment-service", high).raw_impact
    assert payment_low == pytest.approx(payment_high)


def test_strongest_path_is_used_for_dependency_strength():
    graph = build_graph(
        {
            "services": [{"name": name, "criticality": 0.5} for name in "abcd"],
            "dependencies": [
                {"service": "a", "depends_on": "b", "dependency": "hard", "strength": 0.5},
                {"service": "b", "depends_on": "d", "dependency": "hard", "strength": 1.0},
                {"service": "a", "depends_on": "c", "dependency": "hard", "strength": 0.8},
                {"service": "c", "depends_on": "d", "dependency": "hard", "strength": 0.9},
            ],
        }
    )
    parts = by_service(score_failure(graph, "d"))
    assert parts["a"].dependency_strength == pytest.approx(0.72)  # 0.8 x 0.9 beats 0.5 x 1.0
    assert parts["a"].contribution == pytest.approx(0.36)
    assert parts["b"].dependency_strength == pytest.approx(1.0)
    assert parts["c"].dependency_strength == pytest.approx(0.9)


@pytest.mark.parametrize(
    ("score", "expected"),
    [
        (24.99, "LOW"),
        (25, "MEDIUM"),
        (49.99, "MEDIUM"),
        (50, "HIGH"),
        (74.99, "HIGH"),
        (75, "CRITICAL"),
        (100, "CRITICAL"),
    ],
)
def test_severity_boundaries(score, expected):
    assert severity_for(score) == expected


@pytest.mark.parametrize(
    "kwargs",
    [
        {"soft_propagation": 0},
        {"soft_propagation": 1.5},
        {"medium_threshold": 60},  # above the default high threshold (50)
        {"medium_threshold": 0},
        {"critical_threshold": 101},
    ],
)
def test_invalid_scoring_configs_are_rejected(kwargs):
    with pytest.raises(ValueError):
        ScoringConfig(**kwargs)


def test_score_serialises_to_json(graph):
    data = json.loads(json.dumps(score_failure(graph, "payment-service").to_dict()))
    assert data["failed_service"] == "payment-service"
    assert data["severity"] == "HIGH"
    assert data["score"] == pytest.approx(59.6)
    assert data["contributions"][0]["role"] == "failed"


def test_unknown_service_raises(graph):
    with pytest.raises(UnknownServiceError):
        score_failure(graph, "nope")


def test_mismatched_analysis_is_rejected(graph):
    analysis = analyze_failure(graph, "payment-service")
    with pytest.raises(ValueError, match="does not belong"):
        score_failure(graph, "auth-service", analysis=analysis)