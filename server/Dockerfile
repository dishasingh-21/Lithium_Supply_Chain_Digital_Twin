# Builds the combined Node (API + static client) + Python (lithium_twin
# digital twin) image for a single Render Web Service.
#
# Build context MUST be the REPO ROOT (not server/), because this image
# needs to preserve the real repo's sibling-folder layout:
#   <repo root>/server/        <- Express API + static-serves client/
#   <repo root>/lithium_twin/  <- Python package, invoked as `python3 -m lithium_twin.X`
#   <repo root>/client/        <- static HTML/JS/CSS + data/*.json snapshots
# digitalTwinController.js resolves REPO_ROOT as three levels up from
# itself (server/src/controllers/../../..) and lithium_twin/main.py
# resolves its own output path via Path(__file__).parent.parent --
# both assume this exact layout, so it is copied in as-is below.
#
# Debian slim (not Alpine): scipy/numpy/pulp need glibc + prebuilt wheels,
# which musl/Alpine often lacks, forcing slow from-source builds or outright
# failures.
FROM node:20-bookworm-slim

ENV NODE_ENV=production
ENV PYTHON_EXECUTABLE=python3
# Debian/pip 23+ refuses system-wide installs outside a venv by default;
# this is a container with nothing else relying on apt's own Python packages,
# so it's safe to override instead of building a venv.
ENV PIP_BREAK_SYSTEM_PACKAGES=1

# python3-pip pulls in python3 itself; python3-dev + build-essential cover
# any package here that still needs to compile a C extension.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      python3-pip \
      python3-dev \
      build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --- Node dependencies (cached separately from app code) ---
COPY server/package*.json server/
RUN cd server && npm ci --omit=dev

# --- Python dependencies (cached separately from app code) ---
COPY lithium_twin/requirements.txt lithium_twin/requirements.txt
RUN pip3 install --no-cache-dir -r lithium_twin/requirements.txt

# --- App code: server/, lithium_twin/, client/ as siblings, repo-root-rooted ---
COPY server/ server/
COPY lithium_twin/ lithium_twin/
COPY client/ client/

# Bake an initial model_overview.json so GET /api/digital-twin/model has
# something to serve even before the first /run-scenario call. Run from
# /app (the repo-root equivalent) so `python3 -m lithium_twin.main`
# resolves the package the same way it does in local dev.
RUN python3 -m lithium_twin.main

# Drop root for the running process. The node:20 image already ships a
# non-root "node" user; /run-scenario writes fresh JSON snapshots into
# client/data/ at runtime, so that one directory needs to be writable by it
# (everything else the app only reads).
RUN chown -R node:node /app/client/data
USER node

WORKDIR /app/server
EXPOSE 5000
CMD ["node", "server.js"]
