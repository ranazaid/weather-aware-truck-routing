"""Django settings for the Weather-Aware Truck Routing API.

Configuration comes from environment variables so the same image runs locally and on the host.
"""

import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR.parent / ".env")


def env_bool(name: str, default: bool = False) -> bool:
    return os.environ.get(name, str(default)).strip().lower() in {"1", "true", "yes", "on"}


SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "dev-only-insecure-key-change-me")
DEBUG = env_bool("DJANGO_DEBUG", True)
ALLOWED_HOSTS = [h.strip() for h in os.environ.get("DJANGO_ALLOWED_HOSTS", "*").split(",") if h.strip()]
CSRF_TRUSTED_ORIGINS = [o.strip() for o in os.environ.get("DJANGO_CSRF_TRUSTED_ORIGINS", "").split(",") if o.strip()]

INSTALLED_APPS = [
    "django.contrib.contenttypes",
    "django.contrib.staticfiles",
    "corsheaders",
    "rest_framework",
    "planner",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.gzip.GZipMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]
# The API is stateless JSON with no cookie or session auth, so there is nothing for CSRF to protect.
SILENCED_SYSTEM_CHECKS = ["security.W003"]

ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "frontend_dist"],
        "APP_DIRS": False,
        "OPTIONS": {"context_processors": []},
    }
]

# No relational data: plans are cached, not stored. SQLite keeps Django happy without a server.
DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": BASE_DIR / "db.sqlite3"}}

CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "truck-routing",
        "TIMEOUT": 60 * 30,
        "OPTIONS": {"MAX_ENTRIES": 5000},
    }
}

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_TZ = True

STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
# The built React app (Vite writes it to backend/frontend_dist) is served from the site root by WhiteNoise;
# Vite's content-hashed files under /assets/ are cached for a year.
WHITENOISE_ROOT = BASE_DIR / "frontend_dist" if (BASE_DIR / "frontend_dist").exists() else None
WHITENOISE_IMMUTABLE_FILE_TEST = r"^.+[.-][0-9a-zA-Z_-]{8,12}\.(js|css|woff2?|svg|png)$"

CORS_ALLOWED_ORIGINS = [
    o.strip() for o in os.environ.get("CORS_ALLOWED_ORIGINS", "http://localhost:5173").split(",") if o.strip()
]

REST_FRAMEWORK = {
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "DEFAULT_PARSER_CLASSES": ["rest_framework.parsers.JSONParser"],
    "DEFAULT_AUTHENTICATION_CLASSES": [],
    "DEFAULT_PERMISSION_CLASSES": [],
    "UNAUTHENTICATED_USER": None,
    "EXCEPTION_HANDLER": "planner.views.api_exception_handler",
    "DEFAULT_THROTTLE_CLASSES": ["rest_framework.throttling.AnonRateThrottle"],
    "DEFAULT_THROTTLE_RATES": {"anon": os.environ.get("API_RATE_LIMIT", "120/min")},
}

# Third-party providers: all free and keyless.
PROVIDERS = {
    "OSRM_URL": os.environ.get("OSRM_URL", "https://router.project-osrm.org"),
    # Second public OSRM server (FOSSGIS), same API: used when the first is down, slow or rate-limiting.
    # Set to an empty string to disable.
    "OSRM_FALLBACK_URL": os.environ.get("OSRM_FALLBACK_URL", "https://routing.openstreetmap.de/routed-car"),
    "OPEN_METEO_URL": os.environ.get("OPEN_METEO_URL", "https://api.open-meteo.com/v1/forecast"),
    # Backup forecast (MET Norway) for when Open-Meteo is rate-limited or down. Empty disables it.
    "MET_URL": os.environ.get("MET_URL", "https://api.met.no/weatherapi/locationforecast/2.0/complete"),
    "PHOTON_URL": os.environ.get("PHOTON_URL", "https://photon.komoot.io/api/"),
    "NOMINATIM_URL": os.environ.get("NOMINATIM_URL", "https://nominatim.openstreetmap.org/search"),
    "USER_AGENT": os.environ.get(
        "PROVIDER_USER_AGENT", "RouteCast/1.0 (+https://github.com/ranazaid/weather-aware-truck-routing)"
    ),
    "TIMEOUT_S": float(os.environ.get("PROVIDER_TIMEOUT_S", "20")),
}

# Trucks cannot run car-profile speeds: cap per-segment speed when the provider has no truck profile.
TRUCK_SPEED_CAP_MPH = float(os.environ.get("TRUCK_SPEED_CAP_MPH", "65"))

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {"console": {"class": "logging.StreamHandler"}},
    "root": {"handlers": ["console"], "level": os.environ.get("LOG_LEVEL", "INFO")},
}

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

if not DEBUG:
    # Behind the host's TLS-terminating proxy.
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
    SECURE_SSL_REDIRECT = env_bool("DJANGO_SSL_REDIRECT", False)
    SECURE_HSTS_SECONDS = int(os.environ.get("DJANGO_HSTS_SECONDS", "0"))
    SESSION_COOKIE_SECURE = CSRF_COOKIE_SECURE = True
    SECURE_REFERRER_POLICY = "strict-origin-when-cross-origin"
    if SECRET_KEY.startswith("dev-only"):
        raise RuntimeError("Set DJANGO_SECRET_KEY when DJANGO_DEBUG is false.")
