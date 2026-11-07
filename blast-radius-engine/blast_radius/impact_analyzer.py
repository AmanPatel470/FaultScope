"""Failure-propagation analysis over the dependency graph (traversal only).

Reminder: an edge A -> B means "A depends on B". Failure travels AGAINST the edges:
if B fails, every service that can reach B (its ancestors) may be affected.
B's own dependencies (its descendants) are NOT affected by B failing.

Exposure of an affected service:
    "hard" - at least one dependency path to the failed service uses only hard dependencies,
             so the failure can break this service's functionality.
    "soft" - every path includes a soft dependency, so graceful degradation is expected.

Impact scoring and severity are added in risk_scoring.py (Part 2).
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from itertools import islice
from pathlib import Path
from typing import Any

import networkx as nx

from blast_radius.graph_builder import DEFAULT_TOPOLOGY_PATH, load_graph

DEFAULT_MAX_PATHS = 50


class UnknownServiceError(ValueError):
    """The requested service is not in the dependency graph."""


@dataclass(frozen=True)
class AffectedService:
    service: str
    relationship: str  # "direct" (1 hop from the failed service) or "indirect"
    distance: int  # hops along the shortest dependency path to the failed service
    exposure: str  # "hard" or "soft" (see module docstring)
    paths: tuple[tuple[str, ...], ...]  # dependency paths: this service -> ... -> failed service
    paths_truncated: bool  # True if more paths exist than were listed

    def to_dict(self) -> dict[str, Any]:
        return {
            "service": self.service,
            "relationship": self.relationship,
            "distance": self.distance,
            "exposure": self.exposure,
            "paths": [list(path) for path in self.paths],
            "paths_truncated": self.paths_truncated,
        }


@dataclass(frozen=True)
class FailureAnalysis:
    failed_service: str
    affected: tuple[AffectedService, ...]  # sorted by (distance, name)
    unaffected: tuple[str, ...]  # services that do not depend on the failed one, sorted

    @property
    def direct_dependents(self) -> list[str]:
        return [item.service for item in self.affected if item.relationship == "direct"]

    @property
    def indirect_dependents(self) -> list[str]:
        return [item.service for item in self.affected if item.relationship == "indirect"]

    def to_dict(self) -> dict[str, Any]:
        return {
            "failed_service": self.failed_service,
            "direct_dependents": self.direct_dependents,
            "indirect_dependents": self.indirect_dependents,
            "affected": [item.to_dict() for item in self.affected],
            "unaffected": list(self.unaffected),
        }


def _require_service(graph: nx.DiGraph, service: str) -> None:
    if service not in graph:
        known = ", ".join(sorted(graph.nodes))
        raise UnknownServiceError(f"Unknown service '{service}'. Known services: {known}")


def _hard_subgraph(graph: nx.DiGraph) -> nx.DiGraph:
    """Same nodes, but only the hard dependency edges."""
    hard = nx.DiGraph()
    hard.add_nodes_from(graph.nodes)
    hard.add_edges_from(
        (source, target) for source, target, kind in graph.edges(data="dependency") if kind == "hard"
    )
    return hard


def _listed_paths(
    graph: nx.DiGraph, dependent: str, failed: str, max_paths: int
) -> tuple[tuple[tuple[str, ...], ...], bool]:
    """Up to max_paths simple paths dependent -> failed, shortest first, plus a truncation flag."""
    generator = nx.shortest_simple_paths(graph, dependent, failed)
    candidates = [tuple(path) for path in islice(generator, max_paths + 1)]
    truncated = len(candidates) > max_paths
    return tuple(candidates[:max_paths]), truncated


def analyze_failure(
    graph: nx.DiGraph, failed_service: str, max_paths: int = DEFAULT_MAX_PATHS
) -> FailureAnalysis:
    """Work out which services are affected if `failed_service` fails."""
    _require_service(graph, failed_service)
    if max_paths < 1:
        raise ValueError("max_paths must be at least 1")

    hard_graph = _hard_subgraph(graph)
    dependents = nx.ancestors(graph, failed_service)  # everything that can reach the failed service
    distances = dict(nx.single_target_shortest_path_length(graph, failed_service))

    affected = []
    for name in dependents:
        distance = distances[name]
        paths, truncated = _listed_paths(graph, name, failed_service, max_paths)
        affected.append(
            AffectedService(
                service=name,
                relationship="direct" if distance == 1 else "indirect",
                distance=distance,
                exposure="hard" if nx.has_path(hard_graph, name, failed_service) else "soft",
                paths=paths,
                paths_truncated=truncated,
            )
        )
    affected.sort(key=lambda item: (item.distance, item.service))

    unaffected = sorted(set(graph.nodes) - dependents - {failed_service})
    return FailureAnalysis(
        failed_service=failed_service,
        affected=tuple(affected),
        unaffected=tuple(unaffected),
    )


def format_report(analysis: FailureAnalysis) -> str:
    """Human-readable summary used by the command-line tool."""

    def join(names) -> str:
        return ", ".join(names) if names else "(none)"

    lines = [
        f"Failure of {analysis.failed_service}",
        f"  Direct dependents:   {join(analysis.direct_dependents)}",
        f"  Indirect dependents: {join(analysis.indirect_dependents)}",
        f"  Unaffected:          {join(analysis.unaffected)}",
    ]
    for item in analysis.affected:
        hops = "hop" if item.distance == 1 else "hops"
        lines.append("")
        lines.append(f"  {item.service} ({item.relationship}, {item.distance} {hops}, {item.exposure} exposure)")
        for path in item.paths:
            lines.append(f"      {' -> '.join(path)}")
        if item.paths_truncated:
            lines.append("      ... more paths not shown")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Show the blast radius of a failed service.")
    parser.add_argument("service", help="name of the failed service, e.g. payment-service")
    parser.add_argument("--topology", type=Path, default=DEFAULT_TOPOLOGY_PATH, help="path to topology.json")
    parser.add_argument("--json", action="store_true", help="print JSON instead of a text report")
    args = parser.parse_args(argv)

    graph = load_graph(args.topology)
    try:
        analysis = analyze_failure(graph, args.service)
    except UnknownServiceError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    print(json.dumps(analysis.to_dict(), indent=2) if args.json else format_report(analysis))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())