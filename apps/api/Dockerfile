# The API image also serves the built web assets, so a single container fronts the product.
#
# Note on node_modules: Bun installs workspace dependencies into each workspace's own
# node_modules, not only the root. Copying just /app/node_modules into the runtime stage
# leaves every package unable to resolve its imports, so the runtime stage takes the whole
# built tree instead.
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

FROM deps AS build
COPY . .
# `bun --cwd <dir> run <script>` prints help instead of running it, which silently produced
# no assets. A subshell does what was intended.
RUN cd apps/web && bun run build

FROM oven/bun:1.4.2-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 3000
# Applying migrations at start keeps a single-VPS deployment to one command. Split this out
# before running more than one API replica; see docs/DEPLOY.md.
CMD ["sh", "-c", "bun run packages/db/src/migrate.ts && bun run apps/api/src/index.ts"]
