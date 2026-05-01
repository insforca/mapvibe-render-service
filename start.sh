#!/bin/sh
# Start virtual X display — maplibre-gl-native v6 uses X11/GLX on Linux
# DISPLAY=:99 is already set via Dockerfile ENV
Xvfb :99 -screen 0 1024x768x24 +render -noreset &
sleep 1
exec node dist/server.js
