FROM node:20-jammy
WORKDIR /app

# Native deps for canvas (Cairo/Pango) + GL/EGL for maplibre-gl-native
RUN apt-get update && apt-get install -y --no-install-recommends \
    libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    pkg-config build-essential python3 \
    libgl1-mesa-glx libgl1-mesa-dev libegl1 libgles2 \
    fonts-liberation fonts-dejavu-core \
    curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json tsconfig.json ./
# Use npm install (not npm ci) to avoid lock-file sync requirement
RUN npm install --omit=optional 2>&1 || npm install

COPY src/ ./src/
RUN npx tsc

EXPOSE 3000

# Run as non-root
RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser
USER appuser
CMD ["node", "dist/server.js"]
