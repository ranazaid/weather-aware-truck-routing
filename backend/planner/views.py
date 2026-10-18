import logging

from django.conf import settings
from django.http import HttpResponse
from rest_framework import status
from rest_framework.decorators import api_view, throttle_classes
from rest_framework.exceptions import APIException, Throttled, ValidationError
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle
from rest_framework.views import exception_handler

from .domain import geo
from .domain.risk import rules_table
from .domain.sampling import ALLOWED_INTERVALS_MI
from .serializers import MAX_DAYS_AHEAD, MAX_LOAD_LB, PlanRequestSerializer
from .services import geocoding, planner
from .services.http import ProviderError
from .services.weather import Scenario

log = logging.getLogger(__name__)


def _error(code: str, message: str, http_status: int, fields=None) -> Response:
    body = {"error": {"code": code, "message": message}}
    if fields:
        body["error"]["fields"] = fields
    return Response(body, status=http_status)


def api_exception_handler(exc, context):
    """Every API error has the same shape: {"error": {"code", "message", "fields"?}}."""
    if isinstance(exc, ProviderError):
        return _error(exc.code, f"{exc.provider} {exc.message}", exc.status)
    if isinstance(exc, ValidationError):
        detail = exc.detail if isinstance(exc.detail, dict) else {"non_field_errors": exc.detail}
        fields = {k: [str(m) for m in (v if isinstance(v, list) else [v])] for k, v in detail.items()}
        first = next(iter(fields.values()))[0] if fields else "Invalid request."
        return _error("invalid", first, status.HTTP_400_BAD_REQUEST, fields)
    if isinstance(exc, Throttled):
        return _error("throttled", "Too many requests; please wait a moment.", status.HTTP_429_TOO_MANY_REQUESTS)
    response = exception_handler(exc, context)
    if response is not None and isinstance(exc, APIException):
        return _error(exc.default_code, str(exc.detail), response.status_code)
    log.exception("unhandled API error", exc_info=exc)
    return _error("server_error", "Something went wrong on our side.", status.HTTP_500_INTERNAL_SERVER_ERROR)


class GeocodeThrottle(AnonRateThrottle):
    rate = "60/min"


@api_view(["GET"])
def health(request):
    return Response({"status": "ok"})


@api_view(["GET"])
def meta(request):
    return Response(
        {
            "rules": rules_table(),
            "intervals_mi": list(ALLOWED_INTERVALS_MI),
            "max_load_lb": MAX_LOAD_LB,
            "max_days_ahead": MAX_DAYS_AHEAD,
            "truck_speed_cap_mph": settings.TRUCK_SPEED_CAP_MPH,
        }
    )


@api_view(["GET"])
@throttle_classes([GeocodeThrottle])
def geocode(request):
    q = (request.query_params.get("q") or "").strip()
    if len(q) < 2:
        return _error("invalid", "Type at least 2 characters.", status.HTTP_400_BAD_REQUEST, {"q": ["Too short."]})
    return Response({"results": geocoding.search(q[:200])})


@api_view(["POST"])
def plan(request):
    s = PlanRequestSerializer(data=request.data)
    s.is_valid(raise_exception=True)
    v = s.validated_data
    origin = geocoding.resolve(v["origin"])
    destination = geocoding.resolve(v["destination"])
    if geo.haversine_mi((origin["lon"], origin["lat"]), (destination["lon"], destination["lat"])) < 1:
        raise ValidationError({"destination": ["Destination must be at least a mile from the origin."]})
    scenario = Scenario(**v["scenario"]) if v.get("scenario") else Scenario()
    result = planner.build_plan(origin, destination, v["departure"], v["load_lb"], v["interval_mi"], v["hos"], scenario)
    return Response(result)


@api_view(["GET"])
def heatmap(request, plan_id: str):
    data = planner.build_heatmap(plan_id)
    if data is None:
        return _error("plan_expired", "This plan has expired; plan the trip again.", status.HTTP_404_NOT_FOUND)
    return Response(data)


def spa_index(request):
    """Serve the built React app; in development the Vite dev server serves it instead."""
    index = settings.BASE_DIR / "frontend_dist" / "index.html"
    if index.exists():
        response = HttpResponse(index.read_text(encoding="utf-8"), content_type="text/html; charset=utf-8")
        response["Cache-Control"] = "no-cache"  # always pick up a new deploy; hashed assets stay cached
        return response
    return HttpResponse(
        "<h1>Weather-Aware Truck Routing API</h1><p>Frontend not built. Run <code>npm run dev</code> in "
        "<code>frontend/</code> or build it into <code>backend/frontend_dist</code>.</p>",
        content_type="text/html; charset=utf-8",
    )
