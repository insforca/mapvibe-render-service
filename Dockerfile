FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app

# ubuntu:24.04: glibc 2.39 + ICU 74 + libjpeg-turbo8 — ABI match for maplibre-gl-native 6.4.1 prebuilt
# maplibre-gl-native 6.4.1 Linux prebuilt uses X11/GLX (xcb_connect) — not EGL.
# Xvfb provides a virtual X11 display; Mesa GLX uses software rasterizer (llvmpipe) with LIBGL_ALWAYS_SOFTWARE=1.
ENV DISPLAY=:99
ENV LIBGL_ALWAYS_SOFTWARE=1

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
    xvfb \
    fonts-liberation fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

COPY package.json tsconfig.json ./
RUN npm install

COPY src/ ./src/
RUN npx tsc

# ── Build-time smoke tests (DISPLAY=:99 available during build via Xvfb) ──────
RUN find /app/node_modules/@maplibre -name '*.node' | head -1 | xargs ldd 2>&1 | grep 'not found' || echo 'ldd: all libs resolved'

RUN node -e "const {spawnSync}=require('child_process');const r=spawnSync('node',['-e','require(\"@maplibre/maplibre-gl-native\");console.log(\"mbgl OK\")'],{timeout:8000});console.log('mbgl exit:'+r.status+' signal:'+r.signal+' out:'+String(r.stdout).trim()+' err:'+String(r.stderr).trim());" || true

RUN Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp & sleep 1; \
    node -e "const {spawnSync}=require('child_process');const js=\"const mbgl=require('@maplibre/maplibre-gl-native');const m=new mbgl.Map({request:function(r,cb){cb(new Error('x'))},ratio:1});m.load({version:8,sources:{},layers:[{id:'bg',type:'background',paint:{'background-color':'#336699'}}]});m.render({zoom:0,center:[0,0],width:64,height:64,bearing:0,pitch:0},function(err,buf){m.release();if(err){console.error('RENDER FAIL:',err.message);process.exit(1)}else{console.log('RENDER OK buf:'+buf.length)}});\";const r=spawnSync('node',['-e',js],{timeout:20000,env:{...process.env,DISPLAY:':99'}});console.log('render-test exit:'+r.status+' sig:'+r.signal+' out:'+String(r.stdout).trim()+' err:'+String(r.stderr).trim());" || true

RUN node -e "try{require('./node_modules/canvas');console.log('canvas OK')}catch(e){console.error('canvas FAIL:',e.message)}" || true

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
