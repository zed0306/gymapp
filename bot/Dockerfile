# Бот GymApp + HTTP API мини-аппа. Сборка: docker compose build (см. DEPLOY.md)
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    DB_PATH=/data/gymapp.db \
    API_HOST=0.0.0.0 \
    API_PORT=8080

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

# Отдельный пользователь без прав root; /data — для базы (том ./data)
RUN groupadd --system --gid 10001 gymapp \
    && useradd --system --uid 10001 --gid gymapp --home-dir /app --shell /usr/sbin/nologin gymapp \
    && mkdir -p /data && chown gymapp:gymapp /data

# Только код: bot/.env с токеном и локальная база в образ не попадают
COPY bot.py api.py ./

USER gymapp
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/api/health' % os.environ.get('API_PORT', '8080'), timeout=4)" || exit 1

CMD ["python", "bot.py"]
