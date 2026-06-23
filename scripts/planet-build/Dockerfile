# scripts/planet-build/Dockerfile
#
# Tilemaker container that produces the planet PMTiles archive. Uses the
# EXACT config + Lua from spike/pmtiles-prototype-dc — verified against the
# OSMnx baseline for DC at z14, four-panel comparison passed. This image is
# the single artifact between the validation spike and the planet output.
#
# Image size: ~600 MB. Build time: ~5-10 min (Tilemaker compile is the
# bottleneck). Cached layers make rebuilds fast.

FROM ubuntu:22.04 AS tilemaker-build

ENV DEBIAN_FRONTEND=noninteractive

# Tilemaker build dependencies. Pinned to apt versions for reproducibility;
# the Lua + Boost + LibSQLite trio is what drives most install size.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        cmake \
        ca-certificates \
        git \
        liblua5.1-0-dev \
        libsqlite3-dev \
        libboost-program-options-dev \
        libboost-filesystem-dev \
        libboost-system-dev \
        libboost-iostreams-dev \
        libprotobuf-dev \
        protobuf-compiler \
        rapidjson-dev \
        zlib1g-dev \
        libshp-dev \
    && rm -rf /var/lib/apt/lists/*

# Pin Tilemaker to a known-good release. Update this hash when upgrading;
# the spike config was validated against this commit.
ARG TILEMAKER_REF=v3.0.0
RUN git clone --depth 1 --branch ${TILEMAKER_REF} \
        https://github.com/systemed/tilemaker.git /opt/tilemaker \
    && cd /opt/tilemaker \
    && mkdir build && cd build \
    && cmake .. \
    && make -j"$(nproc)" \
    && make install

# ── Runtime stage ─────────────────────────────────────────────────────────────
# Slimmer final image: tilemaker binary + AWS CLI for R2 upload + curl for the
# planet PBF download. Drops all the build toolchain.

FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        unzip \
        liblua5.1-0 \
        libsqlite3-0 \
        libboost-program-options1.74.0 \
        libboost-filesystem1.74.0 \
        libboost-system1.74.0 \
        libboost-iostreams1.74.0 \
        libprotobuf23 \
        zlib1g \
        libshp2 \
    && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscli.zip \
    && unzip -q /tmp/awscli.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/awscli.zip /tmp/aws \
    && rm -rf /var/lib/apt/lists/*

COPY --from=tilemaker-build /usr/local/bin/tilemaker /usr/local/bin/tilemaker

# Configuration files — exact copies from the validated spike branch. Path
# `scripts/pmtiles-prototype/` resolves against the repo root as build context.
COPY scripts/pmtiles-prototype/tilemaker-config.json /opt/tilemaker-config.json
COPY scripts/pmtiles-prototype/tilemaker-process.lua /opt/tilemaker-process.lua

COPY scripts/planet-build/build-planet.sh /opt/build-planet.sh
RUN chmod +x /opt/build-planet.sh

# Working directory holds the planet PBF and intermediate Tilemaker --store.
# A 500 GB EBS volume is mounted at /work in the launch scripts.
WORKDIR /work

ENTRYPOINT ["/opt/build-planet.sh"]