# The API image also serves the built web assets, so a single container fronts the product.
FROM oven/bun:1.4.2-slim AS deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/channels/package.json packages/channels/
COPY packages/config/package.json packages/config/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/infra/package.json packages/infra/
COPY packages/shared/package.json packages/shared/
RUN bun install --frozen-lockfile

FROM deps AS web-build
COPY . .
RUN bun --cwd apps/web run build

FROM oven/bun:1.4.2-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
COPY --from=web-build /app/apps/web/dist ./apps/web/dist
EXPOSE 3000
# Applying migrations at start keeps a single-VPS deployment to one command. Split this out
# once more than one replica can start at the same time.
CMD ["sh", "-c", "bun run packages/db/src/migrate.ts && bun run apps/api/src/index.ts"]
