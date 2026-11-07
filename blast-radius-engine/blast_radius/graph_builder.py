"""Build the service dependency graph from data/topology.json.

DIRECTION CONVENTION (used everywhere in this engine)
    An edge  A -> B  means  "A depends on B".
    If B fails, A may be affected.

So "who is affected when B fails?" is answered by walking edges BACKWARDS from B.
In NetworkX that is nx.ancestors(graph, B): every node that has a path TO B.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import networkx as nx

DEFAULT_TOPOLOGY_PATH = Path(__file__).resolve().parent.parent / "data" / "topology.json"

DEPENDENCY_TYPES = ("hard", "soft")


class TopologyError(ValueError):
    """The topology file is missing, malformed, or internally inconsistent."""


def _is_number(value: Any) -> bool:
    # bool is a subclass of int in Python, so True would otherwise be accepted as 1.
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _is_unit_interval(value: Any) -> bool:
    """True for numbers in (0, 1]: strictly positive and at most 1."""
    return _is_number(value) and 0 < value <= 1


def load_topology(path: Path | str = DEFAULT_TOPOLOGY_PATH) -> dict[str, Any]:
    """Read the topology JSON file. Raises TopologyError for a missing or invalid file."""
    path = Path(path)
    try:
        with path.open(encoding="utf-8") as handle:
            data = json.load(handle)
    except FileNotFoundError as exc:
        raise TopologyError(f"Topology file not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise TopologyError(f"Topology file {path} is not valid JSON: {exc}") from exc

    if not isinstance(data, dict):
        raise TopologyError(f"Topology file {path} must contain a JSON object")
    return data


def build_graph(topology: dict[str, Any]) -> nx.DiGraph:
    """Validate a topology dict and turn it into a directed graph.

    Node attributes: criticality (0, 1], description
    Edge attributes: dependency ("hard" | "soft"), strength (0, 1]
    The graph must be acyclic: cycles make "who depends on whom" ambiguous, so they are rejected.
    """
    services = topology.get("services")
    dependencies = topology.get("dependencies")

    if not isinstance(services, list) or not services:
        raise TopologyError("'services' must be a non-empty list")
    if not isinstance(dependencies, list):
        raise TopologyError("'dependencies' must be a list")

    graph = nx.DiGraph()

    for index, service in enumerate(services):
        if not isinstance(service, dict):
            raise TopologyError(f"services[{index}] must be an object")
        name = service.get("name")
        if not isinstance(name, str) or not name.strip():
            raise TopologyError(f"services[{index}].name must be a non-empty string")
        if name in graph:
            raise TopologyError(f"Duplicate service '{name}'")
        if not _is_unit_interval(service.get("criticality")):
            raise TopologyError(f"Service '{name}': criticality must be a number in (0, 1]")
        graph.add_node(
            name,
            criticality=float(service["criticality"]),
            description=service.get("description", ""),
        )

    for index, dep in enumerate(dependencies):
        label = f"dependencies[{index}]"
        if not isinstance(dep, dict):
            raise TopologyError(f"{label} must be an object")

        source = dep.get("service")
        target = dep.get("depends_on")
        if source not in graph:
            raise TopologyError(f"{label}: unknown service '{source}'")
        if target not in graph:
            raise TopologyError(f"{label}: '{source}' depends on unknown service '{target}'")
        if source == target:
            raise TopologyError(f"{label}: '{source}' cannot depend on itself")
        if dep.get("dependency") not in DEPENDENCY_TYPES:
            raise TopologyError(f"{label}: dependency must be one of {DEPENDENCY_TYPES}")
        if not _is_unit_interval(dep.get("strength")):
            raise TopologyError(f"{label}: strength must be a number in (0, 1]")
        if graph.has_edge(source, target):
            raise TopologyError(f"{label}: duplicate dependency {source} -> {target}")

        graph.add_edge(
            source,
            target,
            dependency=dep["dependency"],
            strength=float(dep["strength"]),
        )

    if not nx.is_directed_acyclic_graph(graph):
        cycle = nx.find_cycle(graph)
        names = [edge[0] for edge in cycle] + [cycle[0][0]]
        raise TopologyError(f"Dependency cycle detected: {' -> '.join(names)}")

    return graph


def load_graph(path: Path | str = DEFAULT_TOPOLOGY_PATH) -> nx.DiGraph:
    """Load and validate the topology file and return the dependency graph."""
    return build_graph(load_topology(path))