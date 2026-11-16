#!/bin/sh
# Container start: prepare the data volume, fetch the voice models once, then run the bot.
set -e
cd /app
mkdir -p "$HOME" .qbhost/voice

# Piper is installed in the image (/opt/piper); the voice setup looks for <voice.dir>/venv.
[ -e .qbhost/voice/venv ] || ln -s /opt/piper .qbhost/voice/venv

# Voice models (~700 MB, with voice.localStt "parakeet" ~490 MB more) are downloaded once into the volume –
# and again after a config change (a new whisperModel/whisperFastModel/localStt; files that are already there
# are skipped). Voice is optional: if this fails, the bot still starts (text chat only) and
# `npx qbhost doctor` says what is missing.
if [ "${QBHOST_VOICE_SETUP:-auto}" != "off" ] && { [ ! -f .qbhost/voice/.ready ] || [ qbhost.config.json -nt .qbhost/voice/.ready ]; }; then
  echo "Sprachmodelle prüfen bzw. einmalig laden (~700 MB, mit Parakeet ~490 MB mehr) …"
  if node_modules/.bin/tsx src/cli.ts voice-setup; then
    touch .qbhost/voice/.ready
  else
    echo "⚠️  Sprach-Setup fehlgeschlagen – der Bot läuft ohne Sprachsteuerung weiter."
  fi
fi

exec "$@"
