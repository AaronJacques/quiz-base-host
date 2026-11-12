#!/bin/sh
# Container start: prepare the data volume, fetch the voice models once, then run the bot.
set -e
cd /app
mkdir -p "$HOME" .qbhost/voice

# Piper is installed in the image (/opt/piper); the voice setup looks for <voice.dir>/venv.
[ -e .qbhost/voice/venv ] || ln -s /opt/piper .qbhost/voice/venv

# Voice models (~700 MB) are downloaded once into the volume. Voice is optional: if this fails,
# the bot still starts (text chat only) and `npx qbhost doctor` says what is missing.
if [ "${QBHOST_VOICE_SETUP:-auto}" != "off" ] && [ ! -f .qbhost/voice/.ready ]; then
  echo "Sprachmodelle fehlen – lade sie einmalig (~700 MB) …"
  if node_modules/.bin/tsx src/cli.ts voice-setup; then
    touch .qbhost/voice/.ready
  else
    echo "⚠️  Sprach-Setup fehlgeschlagen – der Bot läuft ohne Sprachsteuerung weiter."
  fi
fi

exec "$@"
