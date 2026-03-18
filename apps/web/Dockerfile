# syntax=docker/dockerfile:1
FROM node:20-alpine AS base
RUN corepack enable pnpm

# Install dependencies
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml* ./
COPY apps/web/package.json ./apps/web/
COPY packages/aura-dsl/package.json ./packages/aura-dsl/
COPY packages/widget-catalog/package.json ./packages/widget-catalog/
COPY packages/sdk-connectors/package.json ./packages/sdk-connectors/
RUN pnpm install --frozen-lockfile

# Build shared packages first
FROM deps AS build-packages
COPY packages/ ./packages/
COPY tsconfig.base.json ./
RUN pnpm --filter "@lima/aura-dsl" build
RUN pnpm --filter "@lima/widget-catalog" build
RUN pnpm --filter "@lima/sdk-connectors" build

# Build the web app
FROM build-packages AS build-web
ARG NEXT_PUBLIC_DEV_LOGIN
ENV CI=1
ENV NEXT_PUBLIC_DEV_LOGIN=$NEXT_PUBLIC_DEV_LOGIN
COPY apps/web/ ./apps/web/
RUN pnpm --filter "@lima/web" build

# Production image
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=build-web --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=build-web --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static

USER nextjs
EXPOSE 3000
ENV PORT=3000
CMD ["node", "apps/web/server.js"]
