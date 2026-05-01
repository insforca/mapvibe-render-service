FROM node:20-jammy
ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app

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

RUN node -e "require('@maplibre/maplibre-gl-native'); console.log('mbgl OK')" || node -e "process.stdout.write('mbgl ldd: '); require('child_process').execSync('ldd /app/node_modules/@maplibre/maplibre-gl-native/lib/binding/Release/maplibre_gl_native.node 2>&1 | grep not.found || echo none', {stdio: ['inherit','inherit','inherit']}); process.exit(1)"
RUN node -e "require('./node_modules/canvas'); console.log('canvas OK')"

EXPOSE 3000
CMD ["node", "dist/server.js"]
