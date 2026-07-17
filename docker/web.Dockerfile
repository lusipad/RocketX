FROM node:22.17.0-alpine3.22 AS build

WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@11.12.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY packages/app-sdk/package.json packages/app-sdk/package.json
COPY packages/rc-client/package.json packages/rc-client/package.json
COPY packages/rcx-store/package.json packages/rcx-store/package.json

RUN pnpm install --frozen-lockfile

COPY apps/web apps/web
COPY packages/app-sdk packages/app-sdk
COPY packages/rc-client packages/rc-client
COPY packages/rcx-store packages/rcx-store

RUN pnpm --filter @rcx/web build

FROM nginx:1.28.0-alpine3.21

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/apps/web/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=6 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1/healthz || exit 1
