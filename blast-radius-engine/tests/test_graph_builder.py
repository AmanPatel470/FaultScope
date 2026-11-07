"""Tests for topology loading, validation and graph construction."""

import networkx as nx
import pytest

from blast_radius.graph_builder import TopologyError, build_graph, load_graph, load_topology

ALL_SERVICES = {
    "api-gateway",
    "auth-service",
    "order-service",
    "payment-service",
    "inventory-service",
    "notification-service",
}


def base_topology():
    """Smallest valid topology: a -> b (hard), b -> c (soft)."""
    return {
        "services": [
            {"name": "a", "criticality": 0.5},
            {"name": "b", "criticality": 0.5},
            {"name": "c", "criticality": 0.5},
        ],
        "dependencies": [
            {"service": "a", "depends_on": "b", "dependency": "hard", "strength": 1.0},
            {"service": "b", "depends_on": "c", "dependency": "soft", "strength": 0.5},
        ],
    }


def test_default_topology_loads_expected_services_and_edges():
    graph = load_graph()
    assert set(graph.nodes) == ALL_SERVICES
    assert graph.number_of_edges() == 5
    assert nx.is_directed_acyclic_graph(graph)


def test_edge_direction_means_depends_on():
    graph = load_graph()
    assert graph.has_edge("order-service", "payment-service")
    assert not graph.has_edge("payment-service", "order-service")
    assert sorted(graph.successors("order-service")) == [
        "inventory-service",
        "notification-service",
        "payment-service",
    ]
    assert sorted(graph.successors("api-gateway")) == ["auth-service", "order-service"]
    assert sorted(graph.predecessors("payment-service")) == ["order-service"]


def test_edge_and_node_attributes_are_loaded():
    graph = load_graph()
    assert graph["order-service"]["payment-service"]["dependency"] == "hard"
    assert graph["order-service"]["notification-service"]["dependency"] == "soft"
    assert graph.nodes["payment-service"]["criticality"] > graph.nodes["notification-service"]["criticality"]
    for _, _, data in graph.edges(data=True):
        assert 0 < data["strength"] <= 1


def test_minimal_topology_builds():
    graph = build_graph(base_topology())
    assert set(graph.nodes) == {"a", "b", "c"}
    assert graph.number_of_edges() == 2


INVALID_CASES = {
    "empty-services": lambda t: t.update(services=[]),
    "missing-services-key": lambda t: t.pop("services"),
    "missing-dependencies-key": lambda t: t.pop("dependencies"),
    "duplicate-service": lambda t: t["services"].append({"name": "a", "criticality": 0.5}),
    "criticality-zero": lambda t: t["services"][0].update(criticality=0),
    "criticality-above-one": lambda t: t["services"][0].update(criticality=1.5),
    "criticality-bool": lambda t: t["services"][0].update(criticality=True),
    "unknown-depends-on": lambda t: t["dependencies"][0].update(depends_on="zzz"),
    "unknown-service": lambda t: t["dependencies"][0].update(service="zzz"),
    "self-dependency": lambda t: t["dependencies"][0].update(depends_on="a"),
    "bad-dependency-type": lambda t: t["dependencies"][0].update(dependency="medium"),
    "strength-zero": lambda t: t["dependencies"][0].update(strength=0),
    "strength-above-one": lambda t: t["dependencies"][0].update(strength=1.2),
    "duplicate-dependency": lambda t: t["dependencies"].append(dict(t["dependencies"][0])),
    "missing-strength": lambda t: t["dependencies"][0].pop("strength"),
    "cycle": lambda t: t["dependencies"].append(
        {"service": "c", "depends_on": "a", "dependency": "hard", "strength": 1.0}
    ),
}


@pytest.mark.parametrize("mutate", list(INVALID_CASES.values()), ids=list(INVALID_CASES))
def test_invalid_topologies_are_rejected(mutate):
    topology = base_topology()
    mutate(topology)
    with pytest.raises(TopologyError):
        build_graph(topology)


def test_missing_topology_file_raises_topology_error(tmp_path):
    with pytest.raises(TopologyError, match="not found"):
        load_topology(tmp_path / "nope.json")


def test_invalid_json_raises_topology_error(tmp_path):
    broken = tmp_path / "broken.json"
    broken.write_text("{not json", encoding="utf-8")
    with pytest.raises(TopologyError, match="not valid JSON"):
        load_topology(broken)