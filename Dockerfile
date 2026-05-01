FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app

# ── EGL headless stack ────────────────────────────────────────────────────────
# Docker has no GPU / /dev/dri — Mesa must use software rasterizer.
# LIBGL_ALWAYS_SOFTWARE=1     : force Mesa swrast (GL layer)
# MESA_LOADER_DRIVER_OVERRIDE : skip hardware probe, load swrast directly
# EGL_PLATFORM=surfaceless    : no display/DRM needed — fixes mbgl.Map() SIGABRT in Docker
ENV LIBGL_ALWAYS_SOFTWARE=1
ENV MESA_LOADER_DRIVER_OVERRIDE=swrast
ENV EGL_PLATFORM=surfaceless

# ubuntu:24.04: glibc 2.39 + ICU 74 + libjpeg-turbo8 — ABI match for maplibre-gl-native 6.4.1 prebuilt
# libgl1-mesa-dri: swrast_dri.so (Mesa software rasterizer DRI driver)
# libegl-mesa0:    Mesa EGL implementation (surfaceless extension included)
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

# ── Build-time smoke tests ────────────────────────────────────────────────────
# 1. ldd: verify all native deps resolved
RUN find /app/node_modules/@maplibre -name '*.node' | head -1 | xargs ldd 2>&1 | grep 'not found' || echo 'ldd: all libs resolved'

# 2. require() — module loads
RUN node -e "const {spawnSync}=require('child_process');const r=spawnSync('node',['-e','require(\"@maplibre/maplibre-gl-native\");console.log(\"mbgl OK\")'],{timeout:8000});console.log('mbgl exit:'+r.status+' signal:'+r.signal+' out:'+String(r.stdout).trim()+' err:'+String(r.stderr).trim());" || true

# 3. Map() + render() — EGL context creation (the real test; uses spawnSync to survive crash)
RUN node -e "const {spawnSync}=require('child_process');const js=\"const mbgl=require('@maplibre/maplibre-gl-native');const m=new mbgl.Map({request:function(r,cb){cb(new Error('x'))},ratio:1});m.load({version:8,sources:{},layers:[{id:'bg',type:'background',paint:{'background-color':'#336699'}}]});m.render({zoom:0,center:[0,0],width:64,height:64,bearing:0,pitch:0},function(err,buf){m.release();if(err){console.error('RENDER FAIL:',err.message);process.exit(1)}else{console.log('RENDER OK buf:'+buf.length)}});\";const r=spawnSync('node',['-e',js],{timeout:20000});console.log('render-test exit:'+r.status+' sig:'+r.signal+' out:'+String(r.stdout).trim()+' err:'+String(r.stderr).trim());" || true

# 4. canvas
RUN node -e "try{require('./node_modules/canvas');console.log('canvas OK')}catch(e){console.error('canvas FAIL:',e.message)}" || true

EXPOSE 3000
CMD ["node", "dist/server.js"]
