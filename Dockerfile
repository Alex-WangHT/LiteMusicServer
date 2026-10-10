FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ARG YTDLP_VERSION=2026.08.19
RUN python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir "yt-dlp==${YTDLP_VERSION}"
WORKDIR /app
COPY package.json package-lock.json ./
# FFmpeg is provided by the OS; do not download a second binary via npm scripts.
RUN npm ci --omit=dev --ignore-scripts
COPY downloader ./downloader
COPY src/shared.mjs ./src/shared.mjs
ENV NODE_ENV=production YTDLP_PATH=/opt/yt-dlp/bin/yt-dlp FFMPEG_PATH=/usr/bin/ffmpeg
USER node
EXPOSE 8080
CMD ["node", "downloader/server.mjs"]
