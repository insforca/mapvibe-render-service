FROM node:20-jammy
WORKDIR /app

# Runtime deps — all versions match the Ubuntu 22.04 environment the prebuilt binary expects
RUN apt-get update && apt-get install -y --no-install-recommends \
    libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    pkg-config build-essential python3 \
    libgl1-mesa-dev libopengl0 libegl1 libegl-mesa0 libgles2 \
    fonts-liberation fonts-dejavu-core \
    curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json tsconfig.json ./
RUN npm install

COPY src/ ./src/
RUN npx tsc

# Verify both native modules load — build fails here if anything is still missing
RUN node -e "require('@maplibre/maplibre-gl-native'); console.log('mbgl OK')"
RUN node -e "require('./node_modules/canvas'); console.log('canvas OK')"

EXPOSE 3000
CMD ["node", "dist/server.js"]
