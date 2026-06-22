# syntax=docker/dockerfile:1
#
# alsegno — container image.
#
# Base: node:22-bookworm-slim (Debian / glibc), deliberately NOT Alpine / musl.
# better-sqlite3 ships glibc prebuilt binaries; on musl `npm ci` would fall back to a
# from-source node-gyp compile (needs python3 + a C/C++ toolchain), bloating the image and
# slowing the build. glibc keeps it small and the install fast.
#
# Runtime needs ffmpeg + ffprobe on PATH — every upload shells out to them. Debian's ffmpeg is
# built with libx264 / libmp3lame / aac, which the audio-preview and video pipelines require.
#
# Data and uploads live on volumes (see docker-compose.yml): /data holds the SQLite DB (+ its
# WAL/SHM sidecars and the sessions table), /uploads holds transcoded media. The app creates
# both on startup, but we mkdir + chown them here so a fresh *named* volume inherits the
# non-root uid's ownership.

FROM node:22-bookworm-slim

# ffmpeg/ffprobe for the audio+video pipeline; ca-certificates so the prebuild download (and
# any other HTTPS) validates. Strip apt lists to keep the layer lean.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for better layer caching. package-lock.json is present, so `npm ci` does a
# reproducible, lockfile-exact install; --omit=dev skips devDependencies (none today, but this
# keeps it honest). prebuild-install fetches the glibc better-sqlite3 binary during this step.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# App code only — explicit COPY (not `COPY . .`) so data/, uploads/, .env, and planning docs can
# never leak into the image even if .dockerignore drifts.
COPY server.js ./
COPY public ./public

# Container-internal defaults. HOST=0.0.0.0 is REQUIRED: the app defaults to 127.0.0.1, which
# inside a container would only listen on the container's own loopback and be unreachable from
# the host. DATA_DIR/UPLOADS_DIR point at the volume mountpoints; PORT is the fixed internal
# listen port (the host-side port is chosen in docker-compose.yml).
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3458 \
    DATA_DIR=/data \
    UPLOADS_DIR=/uploads

# Run non-root. The base image ships a `node` user (uid/gid 1000). Create + own the volume
# mountpoints as that user so an empty *named* volume is initialised owned by uid 1000 (Docker
# copies the image directory's ownership into a fresh named volume on first use). Bind mounts
# are NOT chowned by Docker — see INSTALL.md for the host-permission note.
RUN mkdir -p /data /uploads && chown -R node:node /data /uploads
USER node

EXPOSE 3458

# Liveness probe: GET /api/me with no cookie. Once the server is up it answers 401 (Not
# authenticated), so 401 — like 200 — means "serving". Uses Node's built-in fetch (stable on
# 22); no curl/wget in the image. Connection refused or 5xx ⇒ unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node","-e","fetch('http://127.0.0.1:'+(process.env.PORT||3458)+'/api/me').then(r=>process.exit(r.status===401||r.status===200?0:1)).catch(()=>process.exit(1))"]

CMD ["node","server.js"]
