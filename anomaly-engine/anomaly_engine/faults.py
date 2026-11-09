"""Fault injection for the synthetic telemetry: events, scheduling, and window labels.

This module never samples telemetry. It turns FaultEvents into Modifiers (conditions per window)
that generator.generate_service() applies, and into window labels.

Fault types (each local to ONE service; cascades between services are not simulated in Phase 4)
    error_burst    a share of requests returns 5xx            (like injected HTTP 500s)
    latency_spike  durations are multiplied                    (like injected delay)
    hang           a share of requests hangs past the timeout  (like injected timeouts)
    traffic_surge  request rate is multiplied (+ mild latency) (like a load spike)
    traffic_drop   request rate collapses                      (like an upstream failure)

Every event draws an intensity u in [0, 1]; the effect size interpolates geometrically between a
MILD value (barely above normal noise) and a STRONG value, so many events are hard to detect.
Events may ramp: the effect grows linearly over `ramp_windows` windows (0 = abrupt step).

Label policy: a window is positive (label 1) if a fault is active in it, including the subtle
first windows of a ramp.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from anomaly_engine.generator import Modifiers

FAULT_TYPES = ("error_burst", "latency_spike", "hang", "traffic_surge", "traffic_drop")


def _lerp_log(low: float, high: float, u: float) -> float:
    return low * (high / low) ** u


# intensity u in [0, 1] -> full-strength effect of the fault
FULL_EFFECT = {
    "error_burst": lambda u: _lerp_log(0.01, 0.6, u),  # extra 5xx probability
    "latency_spike": lambda u: _lerp_log(1.3, 20.0, u),  # latency multiplier
    "hang": lambda u: _lerp_log(0.01, 0.6, u),  # share of hung attempts
    "traffic_surge": lambda u: _lerp_log(1.3, 8.0, u),  # rate multiplier
    "traffic_drop": lambda u: _lerp_log(0.5, 0.02, u),  # rate multiplier (< 1)
}


@dataclass(frozen=True)
class FaultEvent:
    event_id: int
    service: str
    fault_type: str
    start: int  # first affected window (absolute timeline index)
    end: int  # one past the last affected window
    intensity: float
    ramp_windows: int

    @property
    def length(self) -> int:
        return self.end - self.start


def schedule_faults(
    rng: np.random.Generator,
    services,
    first_window: int,
    n_windows: int,
    events_per_service: int = 12,
    min_length: int = 4,
    max_length: int = 20,
    min_gap: int = 10,
    lead: int = 20,
    tail: int = 20,
) -> list[FaultEvent]:
    """Place non-overlapping events for each service inside [first_window, first_window + n_windows)."""
    events: list[FaultEvent] = []
    for service in services:
        n = events_per_service
        if n == 0:
            continue
        lengths = rng.integers(min_length, max_length + 1, size=n)
        remaining = n_windows - lead - tail - int(lengths.sum()) - (n - 1) * min_gap
        if remaining < 0:
            raise ValueError("segment too short for the requested number of fault events")
        cuts = np.sort(rng.integers(0, remaining + 1, size=n))
        types = rng.integers(0, len(FAULT_TYPES), size=n)
        intensities = rng.random(n)
        stepped = rng.random(n) < 0.5
        ramps = np.where(stepped, 0, rng.integers(2, 7, size=n))

        offset = lead
        for i in range(n):
            start = first_window + offset + int(cuts[i])
            events.append(
                FaultEvent(
                    event_id=len(events),
                    service=service,
                    fault_type=FAULT_TYPES[int(types[i])],
                    start=start,
                    end=start + int(lengths[i]),
                    intensity=float(intensities[i]),
                    ramp_windows=int(ramps[i]),
                )
            )
            offset += int(lengths[i]) + min_gap
    return events


def build_modifiers(events, service: str, n_windows: int, start_window: int = 0) -> Modifiers:
    """Conditions and labels for one service over windows [start_window, start_window + n_windows)."""
    mods = Modifiers.neutral(n_windows)
    for event in events:
        if event.service != service:
            continue
        lo, hi = event.start - start_window, event.end - start_window
        if lo < 0 or hi > n_windows:
            raise ValueError(f"event {event.event_id} lies outside the generated windows")
        sl = slice(lo, hi)
        k = np.arange(event.length)
        ramp = np.ones(event.length) if event.ramp_windows == 0 else np.minimum(1.0, (k + 1) / (event.ramp_windows + 1))
        full = FULL_EFFECT[event.fault_type](event.intensity)

        if event.fault_type == "error_burst":
            mods.error_extra[sl] = full * ramp
        elif event.fault_type == "latency_spike":
            mods.latency_mult[sl] = full**ramp
        elif event.fault_type == "hang":
            mods.hang_frac[sl] = full * ramp
        elif event.fault_type == "traffic_surge":
            mods.rate_mult[sl] = full**ramp
            mods.latency_mult[sl] = 1.0 + 0.1 * (mods.rate_mult[sl] - 1.0)  # mild saturation
        elif event.fault_type == "traffic_drop":
            mods.rate_mult[sl] = full**ramp
        else:
            raise ValueError(f"unknown fault type {event.fault_type}")

        mods.label[sl] = 1
        mods.fault_type[sl] = event.fault_type
        mods.event_id[sl] = event.event_id
        mods.progress[sl] = ramp
    return mods