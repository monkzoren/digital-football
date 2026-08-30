# One-shot publisher: builds the TypeScript module with the SpacetimeDB CLI
# and publishes it to the spacetimedb service.
FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN curl -sSf https://install.spacetimedb.com | sh -s -- --yes
ENV PATH="/root/.local/bin:${PATH}"

# Publishing identity: publish.sh mints a token from the server's signing key
# (shared read-only via the spacetimedb-data volume) with fixed claims, so the
# publisher is deterministically the database owner on every deploy — see
# mint-token.mjs. ~/.config/spacetime/cli.toml (the publisher-creds volume)
# only stores the per-run login and serves as a legacy fallback when the
# server key isn't available. Mount ONLY that directory:
# ~/.local/share/spacetime holds the versioned CLI binaries the `spacetime`
# shim execs, so relocating $HOME breaks the shim.
RUN mkdir -p /root/.config/spacetime

WORKDIR /module
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY publish.sh /publish.sh
COPY mint-token.mjs /mint-token.mjs
RUN chmod +x /publish.sh
ENTRYPOINT ["/publish.sh"]
