#!/usr/bin/env bash
# Runs on the VPS as user `deploy` (called by the CI after it copied the release to $QBHOST_HOME/app.new):
# builds the image, switches the release, waits until the bot is ready – and rolls back if it is not.
set -euo pipefail

ROOT=${QBHOST_HOME:-/opt/quizmaster}
TIMEOUT=${DEPLOY_TIMEOUT:-900} # first start downloads the voice models (~700 MB)
cd "$ROOT"
export QBHOST_HOME=$ROOT QBHOST_UID=$(id -u) QBHOST_GID=$(id -g)

for f in .env qbhost.config.json; do
  [ -f "$f" ] || { echo "::error::$ROOT/$f fehlt – einmalig anlegen, siehe docs/DEPLOY.md"; exit 1; }
done
[ -d app.new ] || { echo "::error::$ROOT/app.new fehlt – nichts zu deployen"; exit 1; }
mkdir -p data

compose() { docker compose -f "$ROOT/$1/deploy/compose.yml" "${@:2}"; }

echo "▶ Baue Image (läuft weiter, solange gebaut wird) …"
docker image tag quizmaster:latest quizmaster:prev 2>/dev/null || true
compose app.new build --pull

echo "▶ Schalte Release um …"
rm -rf app.prev
[ -d app ] && mv app app.prev
mv app.new app
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
compose app up -d --remove-orphans

ready() { compose app logs --since "$started" bot 2>/dev/null | grep -q "Bereit\. Befehle mit"; }
restarting() { [ "$(docker inspect -f '{{.State.Restarting}}' "$(compose app ps -q bot)" 2>/dev/null)" = "true" ]; }

echo "▶ Warte auf den Bot (max. ${TIMEOUT}s) …"
for ((t = 0; t < TIMEOUT; t += 5)); do
  if ready; then
    echo "✅ Bot läuft: $(compose app logs --since "$started" bot | grep -m1 'Eingeloggt als' || true)"
    docker image prune -f >/dev/null
    exit 0
  fi
  if restarting; then break; fi
  sleep 5
done

echo "::error::Bot kam nicht hoch – letzte Logs:"
compose app logs --since "$started" --tail 80 bot || true
if [ -d app.prev ] && docker image inspect quizmaster:prev >/dev/null 2>&1; then
  echo "↩ Rollback auf das vorige Release …"
  rm -rf app.failed && mv app app.failed && mv app.prev app
  docker image tag quizmaster:prev quizmaster:latest
  compose app up -d --remove-orphans --no-build
fi
exit 1
