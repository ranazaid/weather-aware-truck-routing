"""One HTTP session for every provider: timeouts, polite retries, and typed errors."""

from __future__ import annotations

import logging
import threading

import requests
from django.conf import settings
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

log = logging.getLogger(__name__)
_local = threading.local()


class ProviderError(Exception):
    """A third-party service failed or returned something unusable. Message is safe to show users."""

    def __init__(self, provider: str, message: str, *, status: int = 502, code: str = "provider_error"):
        super().__init__(f"{provider}: {message}")
        self.provider = provider
        self.message = message
        self.status = status
        self.code = code


def session() -> requests.Session:
    s = getattr(_local, "session", None)
    if s is None:
        s = requests.Session()
        retry = Retry(
            total=3,
            backoff_factor=0.6,
            status_forcelist=(429, 500, 502, 503, 504),
            allowed_methods=frozenset({"GET"}),
            respect_retry_after_header=True,
        )
        adapter = HTTPAdapter(max_retries=retry, pool_maxsize=8)
        s.mount("https://", adapter)
        s.mount("http://", adapter)
        s.headers["User-Agent"] = settings.PROVIDERS["USER_AGENT"]
        _local.session = s
    return s


def get_json(provider: str, url: str, params: dict | None = None):
    try:
        r = session().get(url, params=params, timeout=settings.PROVIDERS["TIMEOUT_S"])
    except requests.Timeout as e:
        raise ProviderError(provider, "timed out; please try again", status=504, code="provider_timeout") from e
    except requests.RequestException as e:
        log.warning("%s request failed: %s", provider, e)
        raise ProviderError(provider, "is unreachable right now; please try again") from e
    if r.status_code == 429:
        raise ProviderError(provider, "rate limit reached; wait a minute and retry", status=503, code="rate_limited")
    try:
        data = r.json()
    except ValueError as e:
        raise ProviderError(provider, f"returned an unreadable response (HTTP {r.status_code})") from e
    if r.status_code >= 400 and not isinstance(data, dict):
        raise ProviderError(provider, f"returned HTTP {r.status_code}")
    return data, r.status_code
