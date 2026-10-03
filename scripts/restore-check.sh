#!/usr/bin/env bash
# Prove the newest backup restores (docs/DEPLOY.md, "Restoring").
#
# Restores the dump into a throwaway Postgres on an internal network of its own — no ports
# published, nothing else attached — compares every table's row count with the counts
# scripts/backup.sh wrote from the same snapshot, then runs the application's migrations
# against it and expects them to change nothing. Everything it starts is removed on exit.
# It never connects to the live database.
#
#   restore-check.sh [dump]     default: the newest chat-db-*.dump in BACKUP_DIR
#
# Reads BACKUP_ENV like backup.sh. APP_IMAGE is the image that runs the migrations (default
# chatbot-integration-api, which compose builds). It is started with `docker run` and only
# the throwaway DATABASE_URL — never `docker compose run`, which would load the app's .env and
# with it the production DATABASE_URL.
set -euo pipefail

ENV_FILE=${BACKUP_ENV:-$HOME/chat-backup.env}
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && . "$ENV_FILE"

BACKUP_DIR=${BACKUP_DIR:-$HOME/chat-backups}
DOCKER=${DOCKER:-docker}
APP_IMAGE=${APP_IMAGE:-chatbot-integration-api}
DB_USER=ci
DB_NAME=chatbot_integration

DUMP=${1:-$(ls -1t "$BACKUP_DIR"/chat-db-*.dump 2>/dev/null | head -1)}
[ -n "$DUMP" ] && [ -s "$DUMP" ] || { echo "no dump found in $BACKUP_DIR" >&2; exit 1; }
COUNTS=${DUMP%.dump}.counts
[ -s "$COUNTS" ] || { echo "no counts file beside $DUMP" >&2; exit 1; }

RUN_ID=restore-check-$$
NET=$RUN_ID
DB=$RUN_ID-db
# A password for a database that lives a few minutes on a network nothing else can reach.
PW=$(head -c 18 /dev/urandom | base64 | tr -d '/+=')
WORK=$(mktemp -d)

cleanup() {
  $DOCKER rm -f -v "$DB" >/dev/null 2>&1 || true
  $DOCKER network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

say() { echo "$(date '+%T') $*"; }
started=$(date +%s)

say "restoring $(basename "$DUMP") ($(du -h "$DUMP" | cut -f1))"
$DOCKER network create --internal "$NET" >/dev/null
$DOCKER run -d --name "$DB" --network "$NET" \
  -e POSTGRES_USER="$DB_USER" -e POSTGRES_PASSWORD="$PW" -e POSTGRES_DB="$DB_NAME" \
  pgvector/pgvector:pg16 >/dev/null

for _ in $(seq 1 60); do
  # The image's entrypoint restarts the server once after initialising; wait for the second.
  if $DOCKER exec "$DB" pg_isready -U "$DB_USER" -d "$DB_NAME" -h 127.0.0.1 >/dev/null 2>&1 &&
    $DOCKER exec "$DB" psql -U "$DB_USER" -d "$DB_NAME" -h 127.0.0.1 -Atc 'select 1' >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

$DOCKER exec -i "$DB" pg_restore -U "$DB_USER" -d "$DB_NAME" --no-owner --exit-on-error <"$DUMP"
restored=$(date +%s)
say "restored in $((restored - started))s"

psql_q() { $DOCKER exec "$DB" psql -U "$DB_USER" -d "$DB_NAME" -Atq -v ON_ERROR_STOP=1 -c "$1"; }
COUNT_SQL="SELECT schemaname || '.' || tablename || ' ' ||
  (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I',
    schemaname, tablename), false, true, '')))[1]::text
  FROM pg_tables WHERE schemaname IN ('public', 'drizzle') ORDER BY 1;"

psql_q "$COUNT_SQL" >"$WORK/restored.counts"
if diff -u "$COUNTS" "$WORK/restored.counts" >"$WORK/diff"; then
  say "row counts match in all $(wc -l <"$COUNTS" | tr -d ' ') tables"
else
  say "ROW COUNTS DIFFER:"
  cat "$WORK/diff"
  exit 1
fi

before=$(psql_q 'select count(*) from drizzle.__drizzle_migrations')
$DOCKER run --rm --network "$NET" \
  -e DATABASE_URL="postgres://$DB_USER:$PW@$DB:5432/$DB_NAME" \
  "$APP_IMAGE" bun run packages/db/src/migrate.ts >"$WORK/migrate.log" 2>&1 ||
  { say "MIGRATE FAILED:"; cat "$WORK/migrate.log"; exit 1; }
after=$(psql_q 'select count(*) from drizzle.__drizzle_migrations')
if [ "$before" != "$after" ]; then
  say "MIGRATIONS WERE MISSING: the dump had $before, the image has $after"
  exit 1
fi
say "migrations: $after applied, the image adds none"

say "restore check passed in $(($(date +%s) - started))s"
