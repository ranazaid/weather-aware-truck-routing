"""Place search for the origin/destination autocomplete: Photon first, Nominatim as fallback."""

from __future__ import annotations

import hashlib
import logging
import re

from django.conf import settings
from django.core.cache import cache

from .http import ProviderError, get_json

log = logging.getLogger(__name__)
CACHE_S = 24 * 3600
_COORD_RE = re.compile(r"^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$")


def _place(label: str, lat: float, lon: float, kind: str | None = None) -> dict:
    return {"label": label, "lat": round(float(lat), 6), "lon": round(float(lon), 6), "kind": kind}


def parse_coordinates(q: str) -> dict | None:
    """Accept "lat, lon" typed directly into the search box."""
    m = _COORD_RE.match(q)
    if not m:
        return None
    lat, lon = float(m.group(1)), float(m.group(2))
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    return _place(f"{lat:.5f}, {lon:.5f}", lat, lon, "coordinates")


def _photon_label(p: dict) -> str:
    parts = [p.get("name"), p.get("city"), p.get("state"), p.get("countrycode") or p.get("country")]
    if p.get("type") == "county" and p.get("name") and "county" not in p["name"].lower():
        parts[0] = f"{p['name']} County"
    out: list[str] = []
    for part in parts:
        if part and part not in out:
            out.append(part)
    return ", ".join(out)


def _photon(q: str, limit: int) -> list[dict]:
    data, status = get_json("Photon geocoder", settings.PROVIDERS["PHOTON_URL"], {"q": q, "limit": limit, "lang": "en"})
    if status >= 400:
        raise ProviderError("Photon geocoder", f"returned HTTP {status}")
    results = []
    for f in data.get("features", []):
        lon, lat = f["geometry"]["coordinates"][:2]
        p = f.get("properties", {})
        results.append(_place(_photon_label(p), lat, lon, p.get("type")))
    return results


def _nominatim(q: str, limit: int) -> list[dict]:
    params = {"q": q, "format": "jsonv2", "limit": limit, "addressdetails": 1}
    data, status = get_json("Nominatim geocoder", settings.PROVIDERS["NOMINATIM_URL"], params)
    if status >= 400 or not isinstance(data, list):
        raise ProviderError("Nominatim geocoder", f"returned HTTP {status}")
    results = []
    for item in data:
        a = item.get("address", {})
        parts = [item.get("name"), a.get("state"), (a.get("country_code") or "").upper() or a.get("country")]
        label = ", ".join(dict.fromkeys(p for p in parts if p)) or item.get("display_name", q)
        results.append(_place(label, item["lat"], item["lon"], item.get("addresstype")))
    return results


def _dedupe(results: list[dict]) -> list[dict]:
    seen, out = set(), []
    for r in results:
        if r["label"] in seen:
            continue
        seen.add(r["label"])
        out.append(r)
    return out


def search(q: str, limit: int = 6) -> list[dict]:
    q = q.strip()
    direct = parse_coordinates(q)
    if direct:
        return [direct]
    key = "geo:" + hashlib.sha1(f"{q.lower()}|{limit}".encode()).hexdigest()
    hit = cache.get(key)
    if hit is not None:
        return hit
    try:
        results = _photon(q, limit)
    except ProviderError as e:
        log.info("Photon failed (%s); falling back to Nominatim", e)
        results = _nominatim(q, limit)
    results = _dedupe(results)
    cache.set(key, results, CACHE_S)
    return results


def resolve(value) -> dict:
    """A place given as {"lat","lon","label"} or as free text (first search hit)."""
    if isinstance(value, dict):
        lat, lon = float(value["lat"]), float(value["lon"])
        label = value.get("label") or f"{lat:.4f}, {lon:.4f}"
        return _place(label, lat, lon, value.get("kind"))
    results = search(str(value), limit=1)
    if not results:
        raise ProviderError("Geocoder", f'could not find "{value}"', status=400, code="place_not_found")
    return results[0]
