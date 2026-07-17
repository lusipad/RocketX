FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3

LABEL org.opencontainers.image.title="RocketX Codex Agent Runner" \
      org.opencontainers.image.version="0.144.4" \
      org.opencontainers.image.source="https://github.com/lusipad/RocketX"

RUN apt-get update \
    && apt-get install --yes --no-install-recommends bubblewrap ca-certificates git ripgrep \
    && npm install --global @openai/codex@0.144.4 \
    && CODEX_BIN="$(find /usr/local/lib/node_modules/@openai/codex/node_modules -path '*/vendor/*/bin/codex' -type f -print -quit)" \
    && test -n "$CODEX_BIN" \
    && cp "$CODEX_BIN" /usr/local/bin/rocketx-codex \
    && cp /usr/local/bin/rocketx-codex /usr/local/bin/codex-linux-sandbox \
    && cp --recursive "$(dirname "$(dirname "$CODEX_BIN")")/codex-resources" /usr/local/bin/codex-resources \
    && chmod 0755 /usr/local/bin/rocketx-codex /usr/local/bin/codex-linux-sandbox /usr/local/bin/codex-resources/bwrap \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

ARG ROCKETX_BWRAP_SETUID=0
RUN if [ "$ROCKETX_BWRAP_SETUID" = "1" ]; then chmod 4755 /usr/local/bin/codex-resources/bwrap; fi

RUN mkdir --parents /home/node/.codex \
    && chown node:node /home/node/.codex

USER node
WORKDIR /workspace
ENV CODEX_HOME=/home/node/.codex

ENTRYPOINT ["/usr/local/bin/rocketx-codex"]
