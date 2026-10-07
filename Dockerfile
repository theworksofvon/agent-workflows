# syntax=docker/dockerfile:1
# The guided review app with git, gh, Claude Code, and Codex. See the README's
# "Run with Docker" section; compose.yaml holds the volumes and the port.

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-slim AS build
WORKDIR /src
# pnpm asks before it replaces a modules directory unless CI is set.
ENV CI=true
RUN npm install --global pnpm@11.15.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json web/
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src src
COPY web web
RUN pnpm exec tsc && pnpm --dir web exec vite build
# Only the backend's production dependencies go to the runtime stage.
RUN rm -rf node_modules web/node_modules \
  && pnpm install --frozen-lockfile --prod --filter agent-workflows

FROM node:${NODE_VERSION}-slim
ARG CLAUDE_CODE_VERSION=2.1.292
ARG CODEX_VERSION=0.160.1

ADD --chmod=644 https://cli.github.com/packages/githubcli-archive-keyring.gpg /etc/apt/keyrings/githubcli-archive-keyring.gpg
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates git \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install --yes --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*
RUN npm install --global \
    "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    "@openai/codex@${CODEX_VERSION}" \
  && npm cache clean --force

# Each directory is a volume or mount point in compose.yaml. A new named
# volume copies the owner from the image, so the node user can write to it.
RUN mkdir -p /var/lib/agent-workflows /home/node/.config/gh /home/node/.claude \
    /home/node/.codex /home/node/.agents/skills \
  && chown -R node:node /var/lib/agent-workflows /home/node

ENV NODE_ENV=production \
  AGENT_WORKFLOWS_CONTAINER=1 \
  STATE_DIR=/var/lib/agent-workflows \
  UI_HOST=0.0.0.0 \
  UI_PORT=4773 \
  GH_CONFIG_DIR=/home/node/.config/gh \
  CLAUDE_CONFIG_DIR=/home/node/.claude \
  CODEX_HOME=/home/node/.codex \
  DISABLE_AUTOUPDATER=1

WORKDIR /app
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules node_modules
COPY --from=build /src/dist dist
COPY --from=build /src/web/dist web/dist
COPY scripts scripts

# Claude Code refuses its permission-bypass flag as root.
USER node
EXPOSE 4773
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.UI_PORT}/api/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/main.js", "start"]
