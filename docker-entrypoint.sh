#!/bin/sh
# Start Xvfb virtual X11 display (maplibre-gl-native 6.4.1 uses X11/GLX)
Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp &
XVFB_PID=$!

# Give Xvfb a moment to start
sleep 0.5

# Start Node server with display set
exec node dist/server.js
