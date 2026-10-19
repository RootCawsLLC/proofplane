# syntax=docker/dockerfile:1
#
# Build context is the proofplane repo ROOT (so the tool packages at /target, /exposure,
# /probe, /catalog and the web app at /web are all available). Referenced from CodeBuild as:
#   docker build -f web/Dockerfile -t <repo>:<tag> .

# ---- build: compile the Node tool packages, then the web app ----
FROM public.ecr.aws/docker/library/node:26-bookworm-slim AS build
WORKDIR /repo
# python3/make/g++ are here so any native postinstall in the tool packages can build from
# source if no prebuilt binary matches the runtime's Node ABI. python3-venv is used in the
# runner stage to install the probe.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*

# The target server (the system under governance) — build its dist/.
COPY target/package.json target/package-lock.json ./target/
RUN cd target && npm ci
COPY target ./target
RUN cd target && npm run build

# The exposure CLI (FAIR loss model) — build its dist/.
COPY exposure/package.json exposure/package-lock.json ./exposure/
RUN cd exposure && npm ci
COPY exposure ./exposure
RUN cd exposure && npm run build

# The probe suite (Python) and the control catalog travel as source; the probe is installed in
# the runner stage, the catalog is read at runtime via --catalog.
COPY probe ./probe
COPY catalog ./catalog

# The web app. It has no dependency on the tool packages at build time (the tool only runs
# out-of-process at request time), so it builds independently.
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci
COPY web ./web
RUN cd web && npm run build

# ---- runner: install the probe, then run `next start` with the full tree in place ----
FROM public.ecr.aws/docker/library/node:26-bookworm-slim AS runner
WORKDIR /repo
ENV NODE_ENV=production
ENV PORT=3300
# The runner resolves the tool at these paths; PROOFPLANE_ROOT is the copied repo tree and
# PROOFPLANE_PYTHON is the venv the probe is installed into below.
ENV PROOFPLANE_ROOT=/repo
ENV PROOFPLANE_PYTHON=/opt/probe-venv/bin/python
# python3 + venv are needed at RUNTIME: each assurance run spawns the real Python probe suite.
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates && rm -rf /var/lib/apt/lists/*

# Bring the whole built tree (target dist + node_modules, exposure dist + node_modules,
# probe source, catalog, web .next + node_modules, scripts).
COPY --from=build /repo /repo

# Install the shipped probe (stdlib + PyYAML) into an isolated venv.
RUN python3 -m venv /opt/probe-venv && /opt/probe-venv/bin/pip install --no-cache-dir /repo/probe

WORKDIR /repo/web
EXPOSE 3300
CMD ["npx", "next", "start", "-p", "3300", "-H", "0.0.0.0"]
