#!/usr/bin/env bash
# Nightly backup of the production database (docs/DEPLOY.md, "Backups").
#
# Dumps Postgres in pg_restore's custom format, writes the row count of every table beside
# it from the same snapshot (so scripts/restore-check.sh has something exact to compare a
# restore with), keeps KEEP_DAYS of both locally, and copies them to BACKUP_REMOTE when set.
#
# Nothing here is specific to one server: where things live comes from the environment,
# which cron loads from BACKUP_ENV (default ~/chat-backup.env). It holds no secrets; the
# database password stays in the app's .env, read by compose and never by this script.
#
#   APP_DIR          the checkout with docker-compose.yml (required)
#   BACKUP_DIR       where dumps go (default ~/chat-backups)
#   KEEP_DAYS        days kept, locally and remotely (default 14)
#   BACKUP_REMOTE    user@host for an offsite copy (optional)
#   BACKUP_REMOTE_DIR  directory on that host (default chat-backups)
#   BACKUP_SSH_KEY   key for that host (default ~/.ssh/chat_backup)
#   DOCKER           how to call docker (default "docker"; "sudo -n docker" where needed)
#
# APP_SECRET_KEY is not in the dump and is not copied: without it the stored provider keys
# and channel credentials cannot be decrypted. Keep the .env somewhere safe yourself.
set -uo pipefail
export PATH="$PATH:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

ENV_FILE=${BACKUP_ENV:-$HOME/chat-backup.env}
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && . "$ENV_FILE"

: "${APP_DIR:?set APP_DIR to the checkout holding docker-compose.yml}"
BACKUP_DIR=${BACKUP_DIR:-$HOME/chat-backups}
KEEP_DAYS=${KEEP_DAYS:-14}
BACKUP_REMOTE=${BACKUP_REMOTE:-}
BACKUP_REMOTE_DIR=${BACKUP_REMOTE_DIR:-chat-backups}
BACKUP_SSH_KEY=${BACKUP_SSH_KEY:-$HOME/.ssh/chat_backup}
DOCKER=${DOCKER:-docker}
DB_USER=ci
DB_NAME=chatbot_integration

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
TS=$(date +%Y%m%d-%H%M%S)
DUMP="$BACKUP_DIR/chat-db-$TS.dump"
COUNTS="$BACKUP_DIR/chat-db-$TS.counts"
LOG="$BACKUP_DIR/backup.log"

log() { echo "$(date '+%F %T %z') $*" >>"$LOG"; }
fail() {
  log "ERROR: $*"
  [ -n "${PSQL_PID:-}" ] && kill "$PSQL_PID" 2>/dev/null
  rm -f "$DUMP" "$COUNTS"
  exit 1
}

cd "$APP_DIR" || fail "APP_DIR $APP_DIR does not exist"
log "=== backup start ($TS) ==="

# One session holds a repeatable-read transaction open and exports its snapshot. The row
# counts are read inside it and pg_dump is pointed at it, so both describe the same instant
# while the application keeps writing.
#
# Every table in the two schemas the app owns; the counts are exact, not estimates.
COUNT_SQL="SELECT schemaname || '.' || tablename || ' ' ||
  (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I',
    schemaname, tablename), false, true, '')))[1]::text
  FROM pg_tables WHERE schemaname IN ('public', 'drizzle') ORDER BY 1;"

# Named pipes rather than `coproc`, which the bash on a Mac does not have.
PIPES=$(mktemp -d)
trap 'rm -rf "$PIPES"' EXIT
mkfifo "$PIPES/in" "$PIPES/out"
$DOCKER compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -Atq -v ON_ERROR_STOP=1 \
  <"$PIPES/in" >"$PIPES/out" 2>>"$LOG" &
PSQL_PID=$!
exec 3>"$PIPES/in" 4<"$PIPES/out"

echo "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot();" >&3
read -r -t 30 SNAPSHOT <&4 || fail "could not open a snapshot"
[[ "$SNAPSHOT" =~ ^[0-9A-F-]+$ ]] || fail "unexpected snapshot id"

echo "$COUNT_SQL SELECT '__end__';" >&3
: >"$COUNTS"
while read -r -t 120 line <&4; do
  [ "$line" = "__end__" ] && break
  echo "$line" >>"$COUNTS"
done
[ -s "$COUNTS" ] || fail "no row counts were read"

if $DOCKER compose exec -T postgres pg_dump -U "$DB_USER" -Fc --snapshot="$SNAPSHOT" "$DB_NAME" \
  >"$DUMP" 2>>"$LOG" && [ -s "$DUMP" ]; then
  log "db dump ok ($(du -h "$DUMP" | cut -f1), $(wc -l <"$COUNTS" | tr -d ' ') tables) $DUMP"
else
  fail "database dump failed or was empty"
fi

echo "COMMIT;" >&3
exec 3>&- 4<&-
wait "$PSQL_PID" 2>/dev/null || true
chmod 600 "$DUMP" "$COUNTS"

find "$BACKUP_DIR" -maxdepth 1 -name 'chat-db-*' -mtime +"$KEEP_DAYS" -delete
log "kept the last $KEEP_DAYS days locally"

if [ -n "$BACKUP_REMOTE" ]; then
  SSH_OPTS=(-i "$BACKUP_SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=30)
  if ssh "${SSH_OPTS[@]}" "$BACKUP_REMOTE" "mkdir -p '$BACKUP_REMOTE_DIR' && chmod 700 '$BACKUP_REMOTE_DIR'" 2>>"$LOG" &&
    scp -q "${SSH_OPTS[@]}" "$DUMP" "$COUNTS" "$BACKUP_REMOTE:$BACKUP_REMOTE_DIR/" 2>>"$LOG"; then
    ssh "${SSH_OPTS[@]}" "$BACKUP_REMOTE" \
      "find '$BACKUP_REMOTE_DIR' -maxdepth 1 -name 'chat-db-*' -mtime +$KEEP_DAYS -delete" 2>>"$LOG"
    log "offsite copy ok -> $BACKUP_REMOTE:$BACKUP_REMOTE_DIR/"
  else
    log "ERROR: offsite copy failed; the local copy is kept"
    exit 1
  fi
fi

log "=== backup done ($TS) ==="
