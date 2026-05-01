FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app

# Force Mesa software rasterizer — Docker has no GPU/DRI device (/dev/dri unavailable)
# Without this, Mesa tries hardware path, fails to open /dev/dri, crashes
ENV LIBGL_ALWAYS_SOFTWARE=1
ENV MESA_LOADER_DRIVER_OVERRIDE=swrast

# ubuntu:24.04: glibc 2.39 + ICU 74 + libjpeg-turbo8 — exact ABI match for maplibre-gl-native 6.4.1 prebuilt
# libgl1-mesa-dri provides swrast_dri.so (Mesa software rasterizer for EGL headless context)
RUN apt-get update && apt-get install -y curl ca-certificates gnupg \
  && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
  && apt-get install -y nodejs \
  && apt-get install -y --no-install-recommends \
    libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    pkg-config build-essential python3 \
    libgl1 libgl1-mesa-dri libglx0 libglx-mesa0 libopengl0 \
    libegl1 libegl-mesa0 libgles2 \
    libx11-6 libxext6 \
    libuv1 \
    fonts-liberation fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

COPY package.json tsconfig.json ./
RUN npm install

COPY src/ ./src/
RUN npx tsc

EXPOSE 3000
CMD ["node", "dist/server.js"]
