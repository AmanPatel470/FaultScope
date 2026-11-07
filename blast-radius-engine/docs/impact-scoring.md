# Impact scoring

> **This is a heuristic, not a probability.** Criticality, dependency strength and the soft
> propagation factor are judgments, not measurements. The score has not been calibrated
> against real incidents. It ranks failures; it does not predict how likely they are.

## Direction convention

An edge `A -> B` means **A depends on B**. If B fails, A may be affected, so failure
propagates against the edges.

## Formula

    impact = sum over affected services i of  C_i x D_i x P_i
    score  = 100 x impact / (sum of all criticalities)

| Symbol | Meaning | Source |
|---|---|---|
| C | Criticality of the service, in (0, 1] | `topology.json` |
| D | Product of edge strengths along the strongest path to the failed service | `topology.json` |
| P | 1.0 for hard exposure, 0.25 for soft exposure | `ScoringConfig.soft_propagation` |

Affected services: the failed service (D = P = 1); all its dependents; and, **only when nothing
depends on the failed service (an entry point)**, every service behind it ("stranded"), because
clients can no longer reach them.

Severity: LOW < 25 <= MEDIUM < 50 <= HIGH < 75 <= CRITICAL.

## Worked examples (default topology, total criticality 4.7)

| Failed service | Calculation | Raw | Score | Severity |
|---|---|---|---|---|
| payment-service | 1.0 + 0.9 (order) + 0.9 (gateway) | 2.8 | 59.6 | HIGH |
| notification-service | 0.3 + 0.9x0.2x0.25 (order) + 1.0x0.18x0.25 (gateway) | 0.39 | 8.3 | LOW |
| api-gateway | 1.0 + 0.8 + 0.81 + 0.63 + 0.9 + 0.0135 (all stranded) | 4.1535 | 88.4 | CRITICAL |

## Limitations

- A failure that leaves its own dependencies without traffic does not count them (if Order
  fails, Payment receives no calls, but Payment is not counted), except for entry points.
- One failed service at a time.
- The dependency graph must be acyclic.
- Exposure (hard/soft) is a model assumption, to be compared with observed behaviour in the
  Phase 5 chaos experiments.