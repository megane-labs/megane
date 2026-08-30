# Stage 0: Build WASM PDB parser
FROM rust:1.93-slim AS wasm
RUN rustup target add wasm32-unknown-unknown && cargo install wasm-pack
WORKDIR /app
COPY Cargo.toml ./
COPY crates/ crates/
RUN cd crates/megane-wasm && wasm-pack build --target web --release

# Stage 1: Build frontend
FROM node:20-slim AS frontend
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY --from=wasm /app/crates/megane-wasm/pkg/ crates/megane-wasm/pkg/
COPY tsconfig.json tsconfig.node.json vite.config.ts vite.widget.config.ts index.html multi-instance.html ./
COPY src/ src/
COPY tests/fixtures/ tests/fixtures/
RUN npx tsc && npx vite build && npx vite build --config vite.widget.config.ts

# Stage 2: Build and install Python package with Rust extension
FROM python:3.11-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl build-essential && \
    rm -rf /var/lib/apt/lists/* && \
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y && \
    pip install --no-cache-dir maturin
ENV PATH="/root/.cargo/bin:${PATH}"
WORKDIR /app

# Copy source needed for maturin build
COPY Cargo.toml ./
COPY crates/ crates/
COPY pyproject.toml README.md LICENSE ./
COPY python/ python/
COPY wheel-share/ wheel-share/
COPY --from=frontend /app/python/megane/static/ python/megane/static/

# Verify frontend assets
RUN test -f python/megane/static/app/index.html || \
    (echo "ERROR: Frontend build missing app/index.html" && exit 1)

# Unified install: compiles Rust extension + installs Python package
RUN pip install --no-cache-dir ".[trajectory]"

# Clean up build tools
RUN apt-get purge -y build-essential && apt-get autoremove -y && \
    rm -rf /root/.cargo /app/target /root/.rustup && \
    pip uninstall -y maturin

# Copy demo data
COPY tests/fixtures/caffeine_water.pdb /data/caffeine_water.pdb
COPY tests/fixtures/caffeine_water_vibration.xtc /data/caffeine_water_vibration.xtc

EXPOSE 8080

CMD ["megane", "serve", "/data/caffeine_water.pdb", "--xtc", "/data/caffeine_water_vibration.xtc", "--port", "8080", "--no-browser"]
