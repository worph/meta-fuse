# meta-fuse standalone Docker image
# Includes: Redis, nginx, FUSE driver, WebDAV, Node.js backend, React UI
#
# Build standalone:
#   docker build -t meta-fuse .
#
# Build with custom meta-core (for development):
#   docker build --build-arg META_CORE_IMAGE=meta-core:local -t meta-fuse .

# Stage 0: Get meta-core binary from published image
ARG META_CORE_IMAGE=ghcr.io/worph/meta-core:latest
FROM ${META_CORE_IMAGE} AS meta-core

# Stage 1: Build UI
FROM node:21-alpine AS ui-builder

WORKDIR /build

# Copy UI package and install
COPY packages/meta-fuse-ui/package.json ./
RUN npm install

# Copy UI source and build
COPY packages/meta-fuse-ui/ ./
RUN npm run build

# Stage 2: Build Backend
FROM node:21-alpine AS backend-builder

WORKDIR /build

# Copy backend package and install
COPY packages/meta-fuse-core/package.json ./
RUN npm install

# Copy backend source and build
COPY packages/meta-fuse-core/tsconfig.json ./
COPY packages/meta-fuse-core/src/ ./src/
RUN npm run build

# Stage 3: Build FUSE Driver
FROM rust:1.83-bookworm AS fuse-builder

WORKDIR /build

# Install FUSE development libraries
RUN apt-get update && apt-get install -y libfuse3-dev pkg-config

# Copy Rust project
COPY packages/meta-fuse-driver/Cargo.toml ./
COPY packages/meta-fuse-driver/src/ ./src/

# Build release binary
RUN cargo build --release

# Stage 4: Runtime
FROM ubuntu:22.04

# Container registry metadata
LABEL org.opencontainers.image.source=https://github.com/worph/meta-fuse
LABEL org.opencontainers.image.description="MetaMesh virtual filesystem via FUSE/WebDAV"
LABEL org.opencontainers.image.licenses=MIT

# Avoid prompts during install
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    gnupg \
    ca-certificates \
    nginx \
    redis-server \
    supervisor \
    fuse3 \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 21
RUN curl -fsSL https://deb.nodesource.com/setup_21.x | bash - \
    && apt-get install -y nodejs

# Install WsgiDAV
RUN pip3 install wsgidav cheroot

# Create directories
RUN mkdir -p \
    /app/backend \
    /app/ui \
    /app/welcome \
    /app/fuse-driver \
    /app/docker \
    /data/watch \
    /data/redis \
    /mnt/virtual \
    /var/log/supervisor \
    /var/log/nginx

# Configure FUSE
RUN echo "user_allow_other" >> /etc/fuse.conf

# Copy built UI
COPY --from=ui-builder /build/dist /app/ui
RUN chmod -R 755 /app/ui

# Copy built backend
COPY --from=backend-builder /build/dist /app/backend/dist
COPY --from=backend-builder /build/node_modules /app/backend/node_modules
COPY --from=backend-builder /build/package.json /app/backend/

# Copy built FUSE driver
COPY --from=fuse-builder /build/target/release/meta-fuse-driver /app/fuse-driver/
RUN chmod +x /app/fuse-driver/meta-fuse-driver

# Copy meta-core sidecar binary
COPY --from=meta-core /usr/local/bin/meta-core /usr/local/bin/meta-core
RUN chmod +x /usr/local/bin/meta-core

# Copy configuration files
COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY docker/supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY docker/wsgidav.yaml /app/docker/
COPY docker/welcome.html /app/welcome/
COPY docker/start-fuse-driver.sh /app/docker/
RUN chmod 644 /app/welcome/welcome.html && \
    chmod +x /app/docker/start-fuse-driver.sh

# Environment variables
ENV NODE_ENV=production \
    REDIS_URL=redis://127.0.0.1:6379 \
    REDIS_PREFIX=meta-sort: \
    API_HOST=0.0.0.0 \
    API_PORT=3000 \
    PUID=1000 \
    PGID=1000

# Expose port 80 (nginx)
EXPOSE 80

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost/health || exit 1

# Start supervisord (manages redis, backend, fuse-driver, wsgidav, nginx)
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
