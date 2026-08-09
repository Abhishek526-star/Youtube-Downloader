FROM python:3.11-slim

# Install FFmpeg + SSL certs + curl for health checks
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ffmpeg \
        ca-certificates \
        curl && \
    update-ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies — pin yt-dlp to latest, upgrade pip first
COPY requirements.txt .
RUN pip install --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt && \
    pip install --no-cache-dir --upgrade yt-dlp

COPY ./app ./app

# Verify FFmpeg is available at build time
RUN ffmpeg -version | head -n 1

EXPOSE 10000

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-10000}"]