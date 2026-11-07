"""Tests for failure traversal: who is affected, how far away, and with what exposure."""

import json

import pytest

from blast_radius.graph_builder import build_graph, load_graph
from blast_radius.impact_analyzer import (
    UnknownServiceError,
    analyze_failure,
    format_report,
)

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


def make_graph(names, edges):
    """edges: (service, depends_on, 'hard'|'soft'). Every edge has strength 1.0."""
    return build_graph(
        {
            "services": [{"name": name, "criticality": 0.5} for name in names],
            "dependencies": [
                {"service": a, "depends_on": b, "dependency": kind, "strength": 1.0}
                for a, b, kind in edges
            ],
        }
    )


def summary(analysis):
    return [(a.service, a.relationship, a.distance, a.exposure) for a in analysis.affected]


def test_payment_failure_hits_order_and_gateway_with_hard_exposure(graph):
    analysis = analyze_failure(graph, "payment-service")
    assert summary(analysis) == [
        ("order-service", "direct", 1, "hard"),
        ("api-gateway", "indirect", 2, "hard"),
    ]
    assert analysis.direct_dependents == ["order-service"]
    assert analysis.indirect_dependents == ["api-gateway"]
    assert analysis.affected[1].paths == (("api-gateway", "order-service", "payment-service"),)
    assert analysis.unaffected == ("auth-service", "inventory-service", "notification-service")


def test_notification_failure_is_soft_for_everyone(graph):
    # Matches Phase 1: orders still succeed with notification "degraded".
    analysis = analyze_failure(graph, "notification-service")
    assert summary(analysis) == [
        ("order-service", "direct", 1, "soft"),
        ("api-gateway", "indirect", 2, "soft"),
    ]
    assert analysis.unaffected == ("auth-service", "inventory-service", "payment-service")


def test_auth_failure_affects_only_the_gateway(graph):
    analysis = analyze_failure(graph, "auth-service")
    assert summary(analysis) == [("api-gateway", "direct", 1, "hard")]
    assert analysis.unaffected == (
        "inventory-service",
        "notification-service",
        "order-service",
        "payment-service",
    )


def test_order_failure_does_not_propagate_down_to_its_dependencies(graph):
    analysis = analyze_failure(graph, "order-service")
    assert summary(analysis) == [("api-gateway", "direct", 1, "hard")]
    for dependency in ("payment-service", "inventory-service", "notification-service"):
        assert dependency in analysis.unaffected


def test_gateway_failure_has_no_dependents(graph):
    analysis = analyze_failure(graph, "api-gateway")
    assert analysis.affected == ()
    assert analysis.direct_dependents == []
    assert analysis.unaffected == (
        "auth-service",
        "inventory-service",
        "notification-service",
        "order-service",
        "payment-service",
    )


@pytest.mark.parametrize("service", ALL_SERVICES)
def test_every_service_is_failed_affected_or_unaffected_exactly_once(graph, service):
    analysis = analyze_failure(graph, service)
    affected = {item.service for item in analysis.affected}
    unaffected = set(analysis.unaffected)
    assert affected.isdisjoint(unaffected)
    assert service not in affected and service not in unaffected
    assert affected | unaffected | {service} == set(graph.nodes)
    assert len(analysis.affected) + len(analysis.unaffected) + 1 == graph.number_of_nodes()


def test_unknown_service_raises(graph):
    with pytest.raises(UnknownServiceError, match="Unknown service 'nope'"):
        analyze_failure(graph, "nope")


def test_exposure_is_hard_when_any_all_hard_path_exists():
    # a has two routes to d: via b (soft first hop) and via c (all hard).
    g = make_graph(
        ["a", "b", "c", "d"],
        [("a", "b", "soft"), ("a", "c", "hard"), ("b", "d", "hard"), ("c", "d", "hard")],
    )
    by_name = {item.service: item for item in analyze_failure(g, "d").affected}
    assert by_name["a"].exposure == "hard"
    assert len(by_name["a"].paths) == 2
    assert by_name["b"].exposure == "hard"
    assert by_name["c"].exposure == "hard"


def test_exposure_is_soft_when_every_path_contains_a_soft_dependency():
    g = make_graph(
        ["a", "b", "c", "d"],
        [("a", "b", "soft"), ("a", "c", "soft"), ("b", "d", "hard"), ("c", "d", "hard")],
    )
    by_name = {item.service: item for item in analyze_failure(g, "d").affected}
    assert by_name["a"].exposure == "soft"
    assert len(by_name["a"].paths) == 2
    assert by_name["b"].exposure == "hard"


def test_distance_and_relationship_follow_the_shortest_path():
    g = make_graph(
        ["a", "b", "c", "d"],
        [("a", "b", "hard"), ("b", "c", "hard"), ("c", "d", "hard")],
    )
    analysis = analyze_failure(g, "d")
    assert summary(analysis) == [
        ("c", "direct", 1, "hard"),
        ("b", "indirect", 2, "hard"),
        ("a", "indirect", 3, "hard"),
    ]


def test_path_listing_is_capped_but_exposure_is_not_affected():
    g = make_graph(
        ["a", "b", "c", "d"],
        [("a", "b", "soft"), ("a", "c", "hard"), ("b", "d", "hard"), ("c", "d", "hard")],
    )
    capped = {i.service: i for i in analyze_failure(g, "d", max_paths=1).affected}["a"]
    assert len(capped.paths) == 1
    assert capped.paths_truncated is True
    assert capped.exposure == "hard"  # computed exactly, not from the truncated path list

    full = {i.service: i for i in analyze_failure(g, "d", max_paths=2).affected}["a"]
    assert len(full.paths) == 2
    assert full.paths_truncated is False


def test_analysis_serialises_to_json(graph):
    data = json.loads(json.dumps(analyze_failure(graph, "payment-service").to_dict()))
    assert data["failed_service"] == "payment-service"
    assert data["direct_dependents"] == ["order-service"]
    assert data["affected"][0]["paths"] == [["order-service", "payment-service"]]


def test_report_mentions_failed_service_and_paths(graph):
    report = format_report(analyze_failure(graph, "payment-service"))
    assert "Failure of payment-service" in report
    assert "order-service -> payment-service" in report
    assert "api-gateway -> order-service -> payment-service" in report