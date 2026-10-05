# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# IndoPolaris — production image
# ---------------------------------------------------------------------------
# Multi-stage. The Prisma schema and the generated client are built in the
# builder and carried into the runner, because `prisma generate` needs the
# schema at generate time but the runtime does not.
# ---------------------------------------------------------------------------

FROM node:22-alpine AS base
# libc6-compat is required by Prisma's query engine on Alpine.
RUN apk add --no-cache libc6-compat
WORKDIR /app

# --- deps ------------------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma7.config.ts ./
# `npm ci` needs the lockfile to match package.json exactly.
RUN npm ci --ignore-scripts

# --- builder ---------------------------------------------------------------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Generate the client against the schema before the build so route handlers and
# server components can typecheck against it.
RUN npx prisma generate
RUN npm run build

# --- runner ----------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Run as a non-root user. The `node` user ships with the base image.
RUN addgroup --system --gid 1001 indopolaris \
 && adduser --system --uid 1001 indopolaris

COPY --from=builder --chown=indopolaris:indopolaris /app/public ./public
# standalone output bundles only the server files actually reached, which keeps
# the runtime image far smaller than copying all of node_modules.
COPY --from=builder --chown=indopolaris:indopolaris /app/.next/standalone ./
COPY --from=builder --chown=indopolaris:indopolaris /app/.next/static ./.next/static

USER indopolaris
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0

CMD ["node", "server.js"]
