FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app

# ubuntu:24.04 (Noble): glibc 2.38 + ICU 74 + libjpeg-turbo8 (LIBJPEG_8.0) — exact match for mbgl prebuilt
RUN apt-get update && apt-get install -y curl ca-certificates gnupg \
  && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
  && apt-get install -y nodejs \
  && apt-get install -y --no-install-recommends \
    libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    pkg-config build-essential python3 \
    libgl1-mesa-dri libopengl0 libegl1 libegl-mesa0 libgles2 \
    libuv1 \
    fonts-liberation fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

COPY package.json tsconfig.json ./
RUN npm install

COPY src/ ./src/
RUN npx tsc

RUN find /app/node_modules/@maplibre -name '*.node' | head -1 | xargs ldd 2>&1 | grep 'not found' || echo 'ldd: all libs resolved'
RUN node -e "require('@maplibre/maplibre-gl-native'); console.log('mbgl OK')"
RUN node -e "require('./node_modules/canvas'); console.log('canvas OK')"

EXPOSE 3000
CMD ["node", "dist/server.js"]
