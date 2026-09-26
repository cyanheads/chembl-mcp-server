# ==============================================================================
# Build Stage
#
# This stage installs all dependencies (including dev), builds the TypeScript
# source code into JavaScript, and prepares the production assets.
#
# Pinned to $BUILDPLATFORM because `bun run build` emits platform-independent
# JavaScript, so this stage must never be emulated. Without the pin, the
# linux/amd64 leg of a multi-arch `buildx` run on an arm64 host executes under
# QEMU, where Bun 1.4.0 aborts during the build with a JavaScriptCore
# MemoryExhaustion assertion (exit 134) and the multi-arch push fails outright.
# The pin holds only while nothing here compiles a native addon — that would
# need the target-arch toolchain and could not cross-compile.
# ==============================================================================
FROM --platform=$BUILDPLATFORM oven/bun:1.4.2 AS build

WORKDIR /usr/src/app

# Copy dependency manifests for optimized layer caching
COPY package.json bun.lock ./

# Install all dependencies (including dev dependencies for building).
# The BuildKit cache mount persists Bun's global package cache across builds.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --ignore-scripts

# Copy the rest of the source code
COPY . .

# Build the application
RUN bun run build


# ==============================================================================
# Production Dependencies Stage
#
# Bun and the security scanner run natively; optional native packages are
# selected explicitly for the target image. Running the scanner under QEMU
# can abort with a JavaScriptCore MemoryExhaustion assertion.
# ==============================================================================
FROM --platform=$BUILDPLATFORM oven/bun:1.4.2 AS production-dependencies

WORKDIR /usr/src/app

ENV NODE_ENV=production
ARG TARGETARCH
ARG TARGETOS
ARG OTEL_ENABLED=true

# Preserve the release-age gate and scanner for production installs.
COPY package.json bun.lock bunfig.toml ./

# The scanner is a devDependency, so seed it before the production-only install.
COPY --from=build /usr/src/app/node_modules/@socketsecurity/bun-security-scanner ./node_modules/@socketsecurity/bun-security-scanner

# Install only production dependencies, ignoring any lifecycle scripts (like 'prepare')
# that are not needed in the final production image.
# `--omit=peer` drops the framework's optional peer tiers (test runner, service
# SDKs, parsers) that Bun would otherwise auto-install. Anything this server
# actually imports is in its own `dependencies` — @duckdb/node-api included — so
# nothing needed at runtime is lost. The OTEL step below carries the same flag:
# without it, that install re-resolves the graph and pulls every peer back in.
#
# @duckdb/node-bindings selects its prebuilt native binary through optional
# dependencies. Both installs must use the target OS/CPU, never the builder's
# defaults. Only the scanner seed comes from the build dependency tree.
# OTEL peers remain opt-out and use the installed framework's declared ranges.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    set -eu; \
    case "$TARGETARCH" in \
      amd64) bun_cpu=x64 ;; \
      arm64) bun_cpu=arm64 ;; \
      *) echo "Unsupported target architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    [ "$TARGETOS" = linux ] || { echo "Unsupported target OS: $TARGETOS" >&2; exit 1; }; \
    bun install --production --omit=peer --frozen-lockfile --ignore-scripts --cpu="$bun_cpu" --os="$TARGETOS"; \
    if [ "$OTEL_ENABLED" = "true" ]; then \
      specs=$(bun -e ' \
        const { peerDependencies: peers } = await Bun.file("node_modules/@cyanheads/mcp-ts-core/package.json").json(); \
        const names = process.argv.slice(1); \
        const missing = names.filter((name) => !peers?.[name]); \
        if (missing.length > 0) throw new Error(`no peerDependencies range for ${missing.join(", ")}`); \
        console.log(names.map((name) => `${name}@${peers[name]}`).join(" ")); \
      ' \
        @hono/otel \
        @opentelemetry/api-logs \
        @opentelemetry/exporter-logs-otlp-http \
        @opentelemetry/exporter-metrics-otlp-http \
        @opentelemetry/exporter-trace-otlp-http \
        @opentelemetry/instrumentation-http \
        @opentelemetry/instrumentation-pino \
        @opentelemetry/resources \
        @opentelemetry/sdk-logs \
        @opentelemetry/sdk-metrics \
        @opentelemetry/sdk-node \
        @opentelemetry/sdk-trace-node \
        @opentelemetry/semantic-conventions); \
      bun add --omit=dev --omit=peer --ignore-scripts --cpu="$bun_cpu" --os="$TARGETOS" $specs; \
    fi

# ==============================================================================
# Production Stage
#
# The slim target-platform runtime receives only production dependencies and
# compiled JavaScript. No Bun process runs under emulation during this stage.
# ==============================================================================
FROM oven/bun:1.4.2-slim AS production

WORKDIR /usr/src/app

ENV NODE_ENV=production

# OCI image metadata (https://github.com/opencontainers/image-spec/blob/main/annotations.md)
ARG APP_VERSION
LABEL org.opencontainers.image.title="chembl-mcp-server"
LABEL org.opencontainers.image.description="Link compounds to protein targets, rank bioactivity (IC50/Ki/EC50), and look up drug mechanisms and indications over ChEMBL via MCP. STDIO or Streamable HTTP."
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.version="${APP_VERSION}"
LABEL org.opencontainers.image.source="https://github.com/cyanheads/chembl-mcp-server"

COPY --from=production-dependencies /usr/src/app/package.json /usr/src/app/bun.lock /usr/src/app/bunfig.toml ./
COPY --from=production-dependencies /usr/src/app/node_modules ./node_modules

# Copy the compiled application code from the build stage
COPY --from=build /usr/src/app/dist ./dist

# The 'oven/bun' image already provides a non-root user named 'bun'.
# We will use this existing user for enhanced security.

# Create and set permissions for the log directory, assigning ownership to the 'bun' user.
RUN mkdir -p /var/log/chembl-mcp-server && chown -R bun:bun /var/log/chembl-mcp-server

# Switch to the non-root user
USER bun

# Define an argument for the port, allowing it to be overridden at build time.
# The `PORT` variable is often injected by cloud environments at runtime.
ARG PORT

# Set runtime environment variables
# Note: PORT is an automatic variable in many cloud environments (e.g., Cloud Run)
ENV MCP_HTTP_PORT=${PORT:-3010}
ENV MCP_HTTP_HOST="0.0.0.0"
ENV MCP_TRANSPORT_TYPE="http"
ENV MCP_SESSION_MODE="stateless"
ENV MCP_LOG_LEVEL="info"
ENV LOGS_DIR="/var/log/chembl-mcp-server"

# Expose the port the server listens on
EXPOSE ${MCP_HTTP_PORT}

# Health check using a bun-native fetch (slim image ships no curl/wget)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD bun -e "fetch('http://localhost:'+(process.env.MCP_HTTP_PORT??'3010')+'/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The command to start the server
CMD ["bun", "run", "dist/index.js"]
