"""HTTP API for the blast radius engine.

    GET  /health    liveness plus graph size
    GET  /graph     the dependency graph (A -> B means A depends on B)
    POST /analyze   {"failed_service": "..."} -> affected services, paths, impact score, severity

Interactive documentation is served at /docs (Swagger UI) and /openapi.json.
Errors use the same shape as the Node services: {"error": {"code", "message", "details?"}}.
"""

import json
import os
import sys
import time
import uuid
from datetime import datetime, timezone
from typing import Literal, Optional

import networkx as nx
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.exceptions import HTTPException as StarletteHTTPException

from blast_radius.graph_builder import load_graph
from blast_radius.impact_analyzer import UnknownServiceError, analyze_failure
from blast_radius.risk_scoring import score_failure

SERVICE_NAME = "blast-radius-engine"
SCORING_MODEL = "heuristic-v1"
INTERPRETATION = (
    "Heuristic, dependency-weighted impact estimate (0-100). "
    "It is not a calibrated failure probability."
)
GRAPH_SEMANTICS = "An edge A -> B means A depends on B. If B fails, A may be affected."

Severity = Literal["LOW", "MEDIUM", "HIGH", "CRITICAL"]


# ---------------------------------------------------------------- request / response models


class AnalyzeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    failed_service: str = Field(
        min_length=1, max_length=64, description="Name of the failed service, e.g. payment-service"
    )


class AffectedServiceModel(BaseModel):
    service: str
    relationship: Literal["direct", "indirect"]
    distance: int
    exposure: Literal["hard", "soft"]
    paths: list[list[str]]
    paths_truncated: bool


class ContributionModel(BaseModel):
    service: str
    role: Literal["failed", "dependent", "stranded"]
    criticality: float
    dependency_strength: float
    propagation_factor: float
    contribution: float


class ImpactModel(BaseModel):
    raw_impact: float
    max_raw_impact: float
    score: float
    severity: Severity
    contributions: list[ContributionModel]
    scoring_model: str
    interpretation: str


class AnalyzeResponse(BaseModel):
    failed_service: str
    direct_dependents: list[str]
    indirect_dependents: list[str]
    affected: list[AffectedServiceModel]
    unaffected: list[str]
    impact: ImpactModel


class NodeModel(BaseModel):
    name: str
    criticality: float
    description: str


class EdgeModel(BaseModel):
    service: str
    depends_on: str
    dependency: Literal["hard", "soft"]
    strength: float


class GraphResponse(BaseModel):
    semantics: str
    nodes: list[NodeModel]
    edges: list[EdgeModel]


class HealthResponse(BaseModel):
    service: str
    status: str
    services: int
    dependencies: int


class ErrorBody(BaseModel):
    code: str
    message: str
    details: Optional[list[dict]] = None


class ErrorResponse(BaseModel):
    error: ErrorBody


# ---------------------------------------------------------------- helpers


def _log(level: str, message: str, **fields) -> None:
    """One JSON object per line, same shape as the Node services' logs."""
    if os.environ.get("LOG_LEVEL", "info").lower() == "silent":
        return
    timestamp = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    entry = {"time": timestamp, "level": level, "service": SERVICE_NAME, "message": message, **fields}
    print(json.dumps(entry), file=sys.stderr if level == "error" else sys.stdout, flush=True)


def _error(status: int, code: str, message: str, details=None, headers=None) -> JSONResponse:
    body: dict = {"error": {"code": code, "message": message}}
    if details:
        body["error"]["details"] = details
    return JSONResponse(status_code=status, content=body, headers=headers)


# ---------------------------------------------------------------- application factory


def create_app(graph: Optional[nx.DiGraph] = None) -> FastAPI:
    """Build the API. Pass a graph to use a custom topology (tests do); default loads topology.json."""
    if graph is None:
        graph = load_graph()

    app = FastAPI(
        title="FaultScope Blast Radius Engine",
        version="1.0.0",
        description=(
            "Dependency-based failure propagation and heuristic impact scoring. "
            + GRAPH_SEMANTICS
            + " "
            + INTERPRETATION
        ),
    )

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        request_id = (request.headers.get("x-request-id") or str(uuid.uuid4()))[:128]
        started = time.perf_counter()
        response = await call_next(request)
        response.headers["x-request-id"] = request_id
        _log(
            "info",
            "request_completed",
            requestId=request_id,
            method=request.method,
            path=request.url.path,
            status=response.status_code,
            durationMs=round((time.perf_counter() - started) * 1000, 2),
        )
        return response

    @app.exception_handler(RequestValidationError)
    async def on_validation_error(request: Request, exc: RequestValidationError):
        details = [
            {"field": ".".join(str(part) for part in err["loc"][1:]) or "body", "message": err["msg"]}
            for err in exc.errors()
        ]
        return _error(400, "VALIDATION_ERROR", "Request validation failed", details)

    @app.exception_handler(StarletteHTTPException)
    async def on_http_exception(request: Request, exc: StarletteHTTPException):
        codes = {404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED"}
        if exc.status_code == 404:
            message = f"Route {request.method} {request.url.path} not found"
        else:
            message = str(exc.detail)
        return _error(exc.status_code, codes.get(exc.status_code, "HTTP_ERROR"), message, headers=exc.headers)

    @app.exception_handler(Exception)
    async def on_unhandled_error(request: Request, exc: Exception):
        _log("error", "unhandled_error", path=request.url.path, message=str(exc))
        return _error(500, "INTERNAL_ERROR", "Internal server error")

    @app.get("/health", response_model=HealthResponse)
    def health():
        return {
            "service": SERVICE_NAME,
            "status": "ok",
            "services": graph.number_of_nodes(),
            "dependencies": graph.number_of_edges(),
        }

    @app.get("/graph", response_model=GraphResponse)
    def graph_view():
        nodes = [
            {"name": name, "criticality": data["criticality"], "description": data["description"]}
            for name, data in sorted(graph.nodes(data=True))
        ]
        edges = [
            {"service": source, "depends_on": target, "dependency": data["dependency"], "strength": data["strength"]}
            for source, target, data in sorted(graph.edges(data=True), key=lambda edge: (edge[0], edge[1]))
        ]
        return {"semantics": GRAPH_SEMANTICS, "nodes": nodes, "edges": edges}

    @app.post(
        "/analyze",
        response_model=AnalyzeResponse,
        responses={400: {"model": ErrorResponse}, 404: {"model": ErrorResponse}},
    )
    def analyze(body: AnalyzeRequest):
        try:
            analysis = analyze_failure(graph, body.failed_service)
        except UnknownServiceError as exc:
            return _error(404, "UNKNOWN_SERVICE", str(exc))

        impact = score_failure(graph, body.failed_service, analysis=analysis).to_dict()
        impact.pop("failed_service")
        payload = analysis.to_dict()
        payload["impact"] = {**impact, "scoring_model": SCORING_MODEL, "interpretation": INTERPRETATION}
        return payload

    return app


app = create_app()