#!/bin/sh
# Start virtual X display — maplibre-gl-native v6 uses X11/GLX on Linux
# DISPLAY=:99 is already set via Dockerfile ENV

Xvfb :99 -screen 0 1024x768x24 +render -noreset &
XVFB_PID=$!

# Wait for Xvfb socket (up to 10 seconds) instead of a fixed sleep
WAIT=0
while [ ! -S /tmp/.X11-unix/X99 ]; do
  WAIT=$((WAIT + 1))
  if [ $WAIT -ge 20 ]; then
    echo "[start.sh] Xvfb :99 failed to become ready after 10s — exiting"
    exit 1
  fi
  sleep 0.5
done
echo "[start.sh] Xvfb :99 ready (${WAIT} × 0.5s)"

# Watchdog: restart Xvfb if it crashes (runs in background, checks every 5s)
(
  while true; do
    sleep 5
    if ! kill -0 $XVFB_PID 2>/dev/null; then
      echo "[start.sh] Xvfb died — restarting..."
      Xvfb :99 -screen 0 1024x768x24 +render -noreset &
      XVFB_PID=$!
      sleep 1
    fi
  done
) &

exec node dist/server.js
