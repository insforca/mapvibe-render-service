FROM node:20-bookworm-slim
WORKDIR /app

# Native deps: canvas (Cairo/Pango), fonts, OpenGL/EGL for maplibre-gl-native
RUN apt-get update && apt-get install -y --no-install-recommends \
    libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    pkg-config build-essential python3 \
    libgl1-mesa-dev libegl1 libegl-mesa0 libgles2 \
    fonts-liberation fonts-dejavu-core fonts-open-sans \
    curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src/ ./src/
RUN npx tsc

EXPOSE 3000

# Run as non-root
RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser
USER appuser
CMD ["node", "dist/server.js"]
