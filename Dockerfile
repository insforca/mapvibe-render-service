FROM node:20-bookworm
WORKDIR /app

# Native deps for canvas (Cairo/Pango) + Mesa GL/EGL for maplibre-gl-native
RUN apt-get update && apt-get install -y --no-install-recommends \
    libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    pkg-config build-essential python3 \
    libgl1 libgl1-mesa-dri libegl1 libegl-mesa0 libgles2 \
    fonts-liberation fonts-dejavu-core \
    curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json tsconfig.json ./
RUN npm install

COPY src/ ./src/
RUN npx tsc

# Quick diagnostic: verify native modules can be loaded
RUN node -e "try { require('@maplibre/maplibre-gl-native'); console.log('mbgl OK'); } catch(e) { console.error('mbgl FAIL:', e.message); }" || true
RUN node -e "try { require('./node_modules/canvas'); console.log('canvas OK'); } catch(e) { console.error('canvas FAIL:', e.message); }" || true

EXPOSE 3000
CMD ["node", "dist/server.js"]
