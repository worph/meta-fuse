#!/bin/bash
# Wait for meta-fuse API to be ready before starting fuse-driver

API_URL="http://127.0.0.1:3000/api/fuse/health"
MAX_WAIT=60
WAIT_INTERVAL=2

echo "[start-fuse-driver] Waiting for meta-fuse API at $API_URL..."

waited=0
while [ $waited -lt $MAX_WAIT ]; do
    if curl -sf "$API_URL" > /dev/null 2>&1; then
        echo "[start-fuse-driver] API is ready after ${waited}s"
        break
    fi
    sleep $WAIT_INTERVAL
    waited=$((waited + WAIT_INTERVAL))
    echo "[start-fuse-driver] Waiting... (${waited}s/${MAX_WAIT}s)"
done

if [ $waited -ge $MAX_WAIT ]; then
    echo "[start-fuse-driver] ERROR: API not ready after ${MAX_WAIT}s, starting anyway..."
fi

echo "[start-fuse-driver] Starting meta-fuse-driver..."
exec /app/fuse-driver/meta-fuse-driver /mnt/virtual http://127.0.0.1:3000
