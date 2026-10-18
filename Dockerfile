# One service: Django serves the API and the built React app (WhiteNoise).

# ---- 1. build the frontend -------------------------------------------------
FROM node:22-alpine AS web
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
# vite.config.ts writes the bundle to ../backend/frontend_dist
RUN npm run build

# ---- 2. runtime ------------------------------------------------------------
FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DJANGO_DEBUG=false \
    PORT=8000
WORKDIR /app/backend
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ ./
COPY --from=web /app/backend/frontend_dist ./frontend_dist
# pre-compressed copies so WhiteNoise can send gzip without doing it per request
RUN python -m whitenoise.compress -q frontend_dist \
    && DJANGO_SECRET_KEY=build-time-check-only python manage.py check --deploy --fail-level ERROR
RUN useradd --create-home app && chown -R app /app
USER app
EXPOSE 8000
# One worker process on purpose: plans are cached in process memory and the heatmap request must
# reach the same process. Threads give concurrency for the I/O-bound provider calls.
CMD gunicorn config.wsgi:application --bind 0.0.0.0:${PORT} --workers 1 --threads 8 --timeout 120 --access-logfile -
