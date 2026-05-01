FROM node:20-bookworm
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    pkg-config build-essential python3 \
    libgl1 libgl1-mesa-dri libopengl0 libegl1 libegl-mesa0 libgles2 \
    fonts-liberation fonts-dejavu-core \
    curl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && ln -sf /usr/lib/x86_64-linux-gnu/libjpeg.so.62 /usr/lib/x86_64-linux-gnu/libjpeg.so.8

COPY package.json tsconfig.json ./
RUN npm install

COPY src/ ./src/
RUN npx tsc

# Show ALL remaining missing libs before testing
RUN find /app/node_modules/@maplibre -name '*.node' | head -1 | xargs ldd 2>&1 | grep 'not found' || echo 'ldd: all libs resolved'
RUN node -e "try { require('@maplibre/maplibre-gl-native'); console.log('mbgl OK'); } catch(e) { console.error('mbgl FAIL:', e.message); }" || true

EXPOSE 3000
CMD ["node", "dist/server.js"]
