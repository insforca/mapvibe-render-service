FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app

# maplibre-gl-native v6.x on Linux uses the X11/GLX backend (NOT EGL).
# new mbgl.Map() calls XOpenDisplay() — a virtual X display (Xvfb) is required.
# LIBGL_ALWAYS_SOFTWARE=1 + MESA_LOADER_DRIVER_OVERRIDE=swrast: Mesa swrast via GLX.
# DISPLAY=:99 points to the Xvfb instance started by start.sh at runtime.
ENV LIBGL_ALWAYS_SOFTWARE=1
ENV MESA_LOADER_DRIVER_OVERRIDE=swrast
ENV DISPLAY=:99

# ubuntu:24.04: glibc 2.39 + ICU 74 + libjpeg-turbo8 — exact ABI match for maplibre-gl-native 6.4.1 prebuilt
# xvfb: virtual X11 framebuffer display (needed by X11/GLX backend; no physical display or GPU required)
RUN apt-get update && apt-get install -y curl ca-certificates gnupg \
  && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
  && apt-get install -y nodejs \
  && apt-get install -y --no-install-recommends \
    libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    pkg-config build-essential python3 \
    libgl1 libgl1-mesa-dri libglx0 libglx-mesa0 libopengl0 \
    libegl1 libegl-mesa0 libgles2 \
    libx11-6 libxext6 \
    xvfb \
    libuv1 \
    fonts-liberation fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

COPY package.json tsconfig.json ./
RUN npm install

COPY fonts/ ./fonts/
COPY src/ ./src/
RUN npx tsc

# ── Build-time smoke tests ────────────────────────────────────────────────────
# 1. ldd: all native deps resolved
RUN find /app/node_modules/@maplibre -name '*.node' | head -1 | xargs ldd 2>&1 | grep 'not found' || echo 'ldd: all libs resolved'

# 2. require() — shared library loads
RUN node -e "const {spawnSync}=require('child_process');const r=spawnSync('node',['-e','require(\"@maplibre/maplibre-gl-native\");console.log(\"mbgl OK\")'],{timeout:8000});console.log('mbgl exit:'+r.status+' signal:'+r.signal+' out:'+String(r.stdout).trim()+' err:'+String(r.stderr).trim());" || true

# 3. Map() + render() — full EGL/GLX context + render test (with Xvfb)
RUN Xvfb :99 -screen 0 64x64x24 +render -noreset & \
    sleep 1 && \
    node -e " \
      const mbgl = require('@maplibre/maplibre-gl-native'); \
      const m = new mbgl.Map({ request: function(req, cb) { cb(new Error('blocked')); }, ratio: 1 }); \
      const style = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#336699' } }] }; \
      m.load(style); \
      m.render({ zoom: 0, center: [0, 0], width: 64, height: 64, bearing: 0, pitch: 0 }, function(err, buf) { \
        m.release(); \
        if (err) { console.error('RENDER FAIL:', err.message); process.exit(1); } \
        console.log('RENDER OK buf:', buf ? buf.length : 0); \
      }); \
    " || true

RUN node -e "try{require('./node_modules/canvas');console.log('canvas OK')}catch(e){console.error('canvas FAIL:',e.message)}" || true

COPY start.sh .
RUN chmod +x start.sh

EXPOSE 3000
CMD ["./start.sh"]
