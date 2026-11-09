"""Seeded synthetic telemetry: one row per service per 30-second window.

This module only knows how to simulate a service under given CONDITIONS (Modifiers). With neutral
modifiers the telemetry is normal. Fault injection lives in faults.py, which only builds Modifiers
and labels; keeping the two apart means the normal generator can be tested on its own.

How a window is simulated
    1. expected request rate = base rate x day/night cycle x burstiness noise x rate_mult
    2. retry amplification: callers retry failed attempts, so the service sees
       1 + p + p^2 + ... attempts per logical request (p = per-attempt failure probability)
    3. attempts ~ Poisson(rate x 30 s x amplification)
    4. every attempt gets a lognormal duration (hung attempts: far above the caller's timeout)
    5. 5xx errors ~ Binomial(attempts, error probability)
    6. timeout_count is DERIVED: attempts slower than the caller's timeout, plus rare background timeouts
    7. p95 is computed from histogram buckets with the same interpolation Prometheus uses

Reproducibility: each service has its own random stream, keyed by the service's position in
SERVICES, so adding a service (or generating a subset) never changes another service's data.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import pandas as pd

from anomaly_engine.features import (
    BUCKET_BOUNDS_SECONDS,
    SERVICES,
    WINDOW_SECONDS,
    WINDOWS_PER_DAY,
    histogram_quantile,
)
from anomaly_engine.profiles import ServiceProfile, get_profile

_BOUNDS = np.asarray(BUCKET_BOUNDS_SECONDS, dtype=float)
_NORMAL_SF = np.vectorize(lambda z: 0.5 * math.erfc(z / math.sqrt(2.0)))


@dataclass
class Modifiers:
    """Per-window conditions. Neutral values mean normal operation."""

    rate_mult: np.ndarray  # multiplies the logical request rate
    latency_mult: np.ndarray  # multiplies the median duration
    error_extra: np.ndarray  # added to the 5xx probability
    hang_frac: np.ndarray  # share of attempts that hang beyond the caller's timeout
    label: np.ndarray  # 1 while a fault is active
    fault_type: np.ndarray  # "" or the fault name
    event_id: np.ndarray  # -1 or the fault event id
    progress: np.ndarray  # 0 when no fault, else ramp progress 0..1

    @classmethod
    def neutral(cls, n: int) -> "Modifiers":
        return cls(
            rate_mult=np.ones(n),
            latency_mult=np.ones(n),
            error_extra=np.zeros(n),
            hang_frac=np.zeros(n),
            label=np.zeros(n, dtype=np.int8),
            fault_type=np.full(n, "", dtype=object),
            event_id=np.full(n, -1, dtype=np.int64),
            progress=np.zeros(n),
        )

    def __len__(self) -> int:
        return len(self.rate_mult)


def service_rng(seed: int, service: str) -> np.random.Generator:
    """Independent random stream for one service, keyed by its canonical position."""
    return np.random.default_rng(np.random.SeedSequence(seed, spawn_key=(SERVICES.index(service),)))


def _attempt_failure_probability(profile: ServiceProfile, mods: Modifiers) -> tuple[np.ndarray, np.ndarray]:
    """Per-attempt probability of a 5xx and of a client-observed timeout, per window."""
    p_error = np.clip(profile.base_error_prob + mods.error_extra, 0.0, 1.0)
    if profile.timeout_s is None:
        return p_error, np.zeros(len(mods))
    median = profile.latency_median_s * mods.latency_mult
    p_slow = _NORMAL_SF(np.log(profile.timeout_s / median) / profile.latency_sigma)
    p_timeout = mods.hang_frac + (1.0 - mods.hang_frac) * p_slow
    p_timeout = np.clip(p_timeout + profile.background_timeout_prob, 0.0, 1.0)
    return p_error, p_timeout


def generate_service(
    profile: ServiceProfile,
    n_windows: int,
    rng: np.random.Generator,
    start_window: int = 0,
    modifiers: Modifiers | None = None,
) -> pd.DataFrame:
    mods = modifiers if modifiers is not None else Modifiers.neutral(n_windows)
    if len(mods) != n_windows:
        raise ValueError("modifiers must have one entry per window")

    window = start_window + np.arange(n_windows)
    day_fraction = window / WINDOWS_PER_DAY
    diurnal = 1.0 + profile.diurnal_amplitude * np.sin(2.0 * np.pi * (day_fraction - profile.diurnal_phase))
    sigma = profile.rate_noise_sigma
    burst = rng.lognormal(mean=-0.5 * sigma * sigma, sigma=sigma, size=n_windows)  # mean 1
    logical_rate = profile.base_rate * diurnal * burst * mods.rate_mult

    p_error, p_timeout = _attempt_failure_probability(profile, mods)
    p_fail = 1.0 - (1.0 - p_error) * (1.0 - p_timeout)
    amplification = sum(p_fail**k for k in range(profile.retries + 1))
    attempts = rng.poisson(logical_rate * WINDOW_SECONDS * amplification).astype(np.int64)

    total = int(attempts.sum())
    window_of = np.repeat(np.arange(n_windows), attempts)
    median = profile.latency_median_s * mods.latency_mult
    latency = median[window_of] * np.exp(profile.latency_sigma * rng.standard_normal(total))
    hung = rng.random(total) < mods.hang_frac[window_of]
    latency[hung] = profile.hang_latency_s * rng.uniform(1.1, 3.0, size=int(hung.sum()))

    nb = len(_BOUNDS) + 1
    bucket = np.searchsorted(_BOUNDS, latency, side="left")
    histogram = np.bincount(window_of * nb + bucket, minlength=n_windows * nb).reshape(n_windows, nb)
    p95 = histogram_quantile(0.95, np.cumsum(histogram, axis=1))
    latency_sum = np.bincount(window_of, weights=latency, minlength=n_windows)

    errors = rng.binomial(attempts, p_error)
    if profile.timeout_s is None:
        timeouts = np.zeros(n_windows)
    else:
        slow = np.bincount(window_of, weights=(latency > profile.timeout_s).astype(float), minlength=n_windows)
        timeouts = slow + rng.binomial(attempts, profile.background_timeout_prob)

    has_traffic = attempts > 0
    safe_attempts = np.where(has_traffic, attempts, 1)
    return pd.DataFrame(
        {
            "window": window.astype(np.int64),
            "service": profile.name,
            "request_rate": attempts / WINDOW_SECONDS,
            "error_rate": np.where(has_traffic, errors / safe_attempts, 0.0),
            "avg_latency": np.where(has_traffic, latency_sum / safe_attempts, 0.0),
            "p95_latency": np.where(has_traffic & ~np.isnan(p95), p95, 0.0),
            "timeout_count": timeouts.astype(float),
            "label": mods.label.astype(np.int8),
            "fault_type": mods.fault_type,
            "event_id": mods.event_id,
            "fault_progress": mods.progress,
        }
    )


def generate_normal(
    seed: int, n_windows: int, services=SERVICES, start_window: int = 0
) -> pd.DataFrame:
    """Normal-only telemetry for the given services (sorted by service order, then window)."""
    frames = [
        generate_service(get_profile(s), n_windows, service_rng(seed, s), start_window)
        for s in sorted(services, key=SERVICES.index)
    ]
    return pd.concat(frames, ignore_index=True)