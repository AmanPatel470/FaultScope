"""Heuristic impact scoring for a failed service.

IMPORTANT: the score is a HEURISTIC. Its inputs (criticality, dependency strength, the soft
propagation factor) are judgments written into topology.json and this file, not measurements,
and the score has not been calibrated against real incidents. Never present it as a probability
of failure. Phase 5 chaos experiments are used to compare predictions with observed impact.

FORMULA
    impact = sum over affected services i of  C_i * D_i * P_i

    C_i  criticality of service i (topology.json), in (0, 1]
    D_i  dependency strength: product of the edge strengths along the STRONGEST path
         between i and the failed service, in (0, 1]
    P_i  propagation factor: 1.0 when service i has HARD exposure to the failure,
         soft_propagation (default 0.25) when its exposure is only SOFT

    The affected services are
      * the failed service itself (D = P = 1)
      * every dependent of the failed service, i.e. every service that can reach it
      * if the failed service is an ENTRY POINT (nothing depends on it), every service behind
        it, because clients can no longer reach them ("stranded"). D and P are then measured
        along the paths from the entry point downwards.

    score    = 100 * impact / (sum of all criticalities)          -> 0..100
    severity = LOW (<25), MEDIUM (<50), HIGH (<75), CRITICAL (>=75)

LIMITATIONS (also listed in docs/impact-scoring.md)
    * Only dependents (and, for entry points, the services behind it) are counted. A failure
      that leaves its own dependencies without traffic does not count those dependencies:
      e.g. if Order fails, Payment receives no calls, but Payment is not counted.
    * One failed service at a time.
    * Strengths, criticalities and the soft factor are judgments, not measurements.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import networkx as nx

from blast_radius.graph_builder import DEFAULT_TOPOLOGY_PATH, load_graph
from blast_radius.impact_analyzer import (
    FailureAnalysis,
    UnknownServiceError,
    analyze_failure,
    hard_subgraph,
)

SEVERITIES = ("LOW", "MEDIUM", "HIGH", "CRITICAL")


@dataclass(frozen=True)
class ScoringConfig:
    soft_propagation: float = 0.25
    medium_threshold: float = 25.0
    high_threshold: float = 50.0
    critical_threshold: float = 75.0

    def __post_init__(self) -> None:
        if not 0 < self.soft_propagation <= 1:
            raise ValueError("soft_propagation must be in (0, 1]")
        if not 0 < self.medium_threshold < self.high_threshold < self.critical_threshold <= 100:
            raise ValueError("thresholds must satisfy 0 < medium < high < critical <= 100")


DEFAULT_CONFIG = ScoringConfig()


@dataclass(frozen=True)
class Contribution:
    service: str
    role: str  # "failed" | "dependent" | "stranded"
    criticality: float  # C
    dependency_strength: float  # D
    propagation_factor: float  # P
    contribution: float  # C * D * P

    def to_dict(self) -> dict[str, Any]:
        return {
            "service": self.service,
            "role": self.role,
            "criticality": round(self.criticality, 4),
            "dependency_strength": round(self.dependency_strength, 4),
            "propagation_factor": round(self.propagation_factor, 4),
            "contribution": round(self.contribution, 4),
        }


@dataclass(frozen=True)
class ImpactScore:
    failed_service: str
    raw_impact: float
    max_raw_impact: float  # sum of all criticalities: the impact if everything were lost
    score: float  # 0..100, rounded to one decimal
    severity: str
    contributions: tuple[Contribution, ...]  # failed service first, then largest contribution first

    def to_dict(self) -> dict[str, Any]:
        return {
            "failed_service": self.failed_service,
            "raw_impact": round(self.raw_impact, 4),
            "max_raw_impact": round(self.max_raw_impact, 4),
            "score": self.score,
            "severity": self.severity,
            "contributions": [item.to_dict() for item in self.contributions],
        }


def severity_for(score: float, config: ScoringConfig = DEFAULT_CONFIG) -> str:
    if score >= config.critical_threshold:
        return "CRITICAL"
    if score >= config.high_threshold:
        return "HIGH"
    if score >= config.medium_threshold:
        return "MEDIUM"
    return "LOW"


def _strength_cost(_source: str, _target: str, data: dict[str, Any]) -> float:
    # Maximising a product of strengths in (0, 1] equals minimising the sum of -ln(strength),
    # so the strongest path is a shortest path under this non-negative cost.
    return max(0.0, -math.log(data["strength"]))


def _strongest_path_strengths(graph: nx.DiGraph, origin: str, toward_failed: bool) -> dict[str, float]:
    """D for every service connected to `origin`: the product of strengths on the strongest path.

    toward_failed=True : paths from each dependent TO the failed service (walk edges backwards).
    toward_failed=False: paths from the failed entry point DOWN to each service behind it.
    """
    view = graph.reverse(copy=False) if toward_failed else graph
    costs = nx.single_source_dijkstra_path_length(view, origin, weight=_strength_cost)
    return {node: math.exp(-cost) for node, cost in costs.items() if node != origin}


def _contribution(graph: nx.DiGraph, service: str, role: str, strength: float, propagation: float) -> Contribution:
    criticality = graph.nodes[service]["criticality"]
    return Contribution(
        service=service,
        role=role,
        criticality=criticality,
        dependency_strength=strength,
        propagation_factor=propagation,
        contribution=criticality * strength * propagation,
    )


def score_failure(
    graph: nx.DiGraph,
    failed_service: str,
    config: ScoringConfig = DEFAULT_CONFIG,
    analysis: FailureAnalysis | None = None,
) -> ImpactScore:
    """Score the impact of `failed_service` failing. Pass `analysis` to avoid recomputing it."""
    if analysis is None:
        analysis = analyze_failure(graph, failed_service, max_paths=1)  # raises UnknownServiceError
    elif analysis.failed_service != failed_service:
        raise ValueError("analysis does not belong to the given failed service")

    failed_criticality = graph.nodes[failed_service]["criticality"]
    failed_part = Contribution(failed_service, "failed", failed_criticality, 1.0, 1.0, failed_criticality)

    others: list[Contribution] = []

    upstream = _strongest_path_strengths(graph, failed_service, toward_failed=True)
    for item in analysis.affected:
        propagation = 1.0 if item.exposure == "hard" else config.soft_propagation
        others.append(_contribution(graph, item.service, "dependent", upstream[item.service], propagation))

    if graph.in_degree(failed_service) == 0:  # entry point: nobody depends on it
        downstream = _strongest_path_strengths(graph, failed_service, toward_failed=False)
        hard = hard_subgraph(graph)
        for name, strength in downstream.items():
            propagation = 1.0 if nx.has_path(hard, failed_service, name) else config.soft_propagation
            others.append(_contribution(graph, name, "stranded", strength, propagation))

    # Round inside the sort key so floating-point noise cannot reorder equal contributions.
    others.sort(key=lambda part: (-round(part.contribution, 9), part.service))
    contributions = (failed_part, *others)

    raw = sum(part.contribution for part in contributions)
    total = sum(criticality for _, criticality in graph.nodes(data="criticality"))
    score = min(100.0, round(100 * raw / total, 1))

    return ImpactScore(
        failed_service=failed_service,
        raw_impact=raw,
        max_raw_impact=total,
        score=score,
        severity=severity_for(score, config),
        contributions=contributions,
    )


def format_report(result: ImpactScore) -> str:
    lines = [
        f"Impact score for failure of {result.failed_service}",
        f"  raw impact  {result.raw_impact:.4f} (maximum possible {result.max_raw_impact:.4f})",
        f"  score       {result.score:.1f} / 100",
        f"  severity    {result.severity}",
        "",
        f"  {'service':<22}{'role':<11}{'C':>6}{'D':>7}{'P':>7}{'C*D*P':>9}",
    ]
    for part in result.contributions:
        lines.append(
            f"  {part.service:<22}{part.role:<11}{part.criticality:>6.2f}"
            f"{part.dependency_strength:>7.2f}{part.propagation_factor:>7.2f}{part.contribution:>9.4f}"
        )
    lines.append("")
    lines.append("  Heuristic estimate, not a calibrated failure probability.")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Score the impact of a failed service.")
    parser.add_argument("service", help="name of the failed service, e.g. payment-service")
    parser.add_argument("--topology", type=Path, default=DEFAULT_TOPOLOGY_PATH, help="path to topology.json")
    parser.add_argument("--json", action="store_true", help="print JSON instead of a text report")
    args = parser.parse_args(argv)

    graph = load_graph(args.topology)
    try:
        result = score_failure(graph, args.service)
    except UnknownServiceError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    print(json.dumps(result.to_dict(), indent=2) if args.json else format_report(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())