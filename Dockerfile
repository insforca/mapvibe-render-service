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
    python3-pip python3-venv \
    libgeos-dev libproj-dev libgdal-dev \
  && rm -rf /var/lib/apt/lists/*

COPY package.json tsconfig.json ./
RUN npm install

# ── Python OSM renderer venv ──────────────────────────────────────────────────
COPY python/requirements.txt ./python/requirements.txt
RUN python3 -m venv /opt/mapvibe-py \
  && /opt/mapvibe-py/bin/pip install --no-cache-dir --upgrade pip \
  && /opt/mapvibe-py/bin/pip install --no-cache-dir 'setuptools<82' \
  && /opt/mapvibe-py/bin/pip install --no-cache-dir -r python/requirements.txt
ENV MAPVIBE_PYTHON=/opt/mapvibe-py/bin/python3
