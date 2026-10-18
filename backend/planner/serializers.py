from datetime import UTC, datetime, timedelta

from rest_framework import serializers

from .domain import geo
from .domain.sampling import ALLOWED_INTERVALS_MI

MAX_LOAD_LB = 80_000  # US federal gross-weight limit; no legal load can exceed it
MAX_DAYS_AHEAD = 7
PAST_GRACE = timedelta(hours=1)


class PlaceField(serializers.Field):
    """A place is either {"lat", "lon", "label"?} (from autocomplete) or free text to geocode."""

    default_error_messages = {"invalid": "Enter a place name or an object with lat and lon."}

    def to_internal_value(self, data):
        if isinstance(data, str):
            text = data.strip()
            if len(text) < 2:
                raise serializers.ValidationError("Enter at least 2 characters.")
            return text
        if isinstance(data, dict):
            try:
                lat, lon = float(data["lat"]), float(data["lon"])
            except (KeyError, TypeError, ValueError):
                self.fail("invalid")
            if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                raise serializers.ValidationError("Latitude or longitude is out of range.")
            label = str(data.get("label") or "").strip()[:200]
            return {"lat": lat, "lon": lon, "label": label or f"{lat:.4f}, {lon:.4f}"}
        self.fail("invalid")

    def to_representation(self, value):
        return value


class PlanRequestSerializer(serializers.Serializer):
    origin = PlaceField()
    destination = PlaceField()
    departure = serializers.DateTimeField(default_timezone=UTC)
    load_lb = serializers.FloatField(min_value=0, max_value=MAX_LOAD_LB)
    interval_mi = serializers.ChoiceField(choices=ALLOWED_INTERVALS_MI, default=25)
    hos = serializers.BooleanField(default=True)

    def validate_departure(self, value: datetime) -> datetime:
        now = datetime.now(UTC)
        if value < now - PAST_GRACE:
            raise serializers.ValidationError("Departure cannot be in the past.")
        if value > now + timedelta(days=MAX_DAYS_AHEAD):
            raise serializers.ValidationError(
                f"Departure must be within the next {MAX_DAYS_AHEAD} days (forecast range)."
            )
        return max(value, now - PAST_GRACE)

    def validate(self, attrs):
        o, d = attrs["origin"], attrs["destination"]
        if isinstance(o, dict) and isinstance(d, dict):
            if geo.haversine_mi((o["lon"], o["lat"]), (d["lon"], d["lat"])) < 1:
                raise serializers.ValidationError(
                    {"destination": "Destination must be at least a mile from the origin."}
                )
        elif isinstance(o, str) and isinstance(d, str) and o.lower() == d.lower():
            raise serializers.ValidationError({"destination": "Destination must differ from the origin."})
        return attrs
