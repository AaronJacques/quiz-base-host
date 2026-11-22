#!/usr/bin/env bash
# quiz-base login on the VPS – run by `npx qbhost login --server <host>` ON THE MAC: the Mac sends this
# file from its own checkout as the argument of `ssh <host> bash -c '…'` (it is never read from the release
# folder on the server, which the deploy can write). Runs as the SSH user; the only privileged calls are
# `sudo -n docker …` with fixed arguments. Everything that can fail runs BEFORE the bot is stopped.
#
#   bash server-login.sh login    stop the bot, run `qbhost login --remote-stdio` in a throw-away container
#                                 (stdin/stdout = relay), start the bot
#   bash server-login.sh logout   stop the bot, delete the browser profile, start the bot
#   bash server-login.sh status <before>
#                                 after a run: wait until the login container is gone; exit 0 if the bot runs,
#                                 3 if it ran before (<before> = running) but not now (with the start command),
#                                 4 if it was already off before (or untouched) and is still off
#
# Image, user, data and config paths come from the bot container itself (docker inspect), the profile path
# from the bot's config (`login --print-profile-dir`). stdout belongs to the relay – messages go to stderr;
# the only line of our own on stdout is `QBBOT running|stopped` before anything changes (state before the run).
# The bot is started again on every exit if it was running before (and stays stopped if it was not); while
# it is stopped its restart policy is "always", so a reboot or dockerd restart mid-login starts it, too.
set -u
trap '' PIPE # a dead ssh must not kill us before the bot is started again

mode=${1:-}
name=qbhost-login
limit=${QBHOST_LOGIN_LIMIT:-930} # 15 min login + start-up + final check; the container has its own 15-min limit
grace=${QBHOST_LOGIN_GRACE:-20}  # after SIGTERM: hard kill (timeout -k)
statuswait=${QBHOST_STATUS_WAIT:-90}   # status: how long the login container may still be cleaning up
startwait=${QBHOST_STATUS_START_WAIT:-20} # status: then how long the bot may take to come up
stable=${QBHOST_STATUS_STABLE:-3}         # status: seconds in a row it must run (a crash loop is not "running")

say() { printf '%s\n' "$*" >&2 2>/dev/null || true; }
d() { sudo -n docker "$@"; }
# Absolute, plain segments only: no "." or ".." segments, no empty segments, no trailing slash.
path_ok() { [[ $1 =~ ^(/[A-Za-z0-9._-]+)+$ ]] && [[ ! $1 =~ (^|/)\.{1,2}(/|$) ]]; }
findbot() { d ps -aq --filter label=com.docker.compose.project=quizmaster --filter label=com.docker.compose.service=bot 2>/dev/null | head -n 1; }
is_running() { [ "$(d inspect -f '{{.State.Running}}/{{.State.Restarting}}' "$1" 2>/dev/null)" = true/false ]; }

case $mode in login | logout | status) ;; *) say "❌ server-login.sh: unbekannter Modus \"$mode\""; exit 2 ;; esac

bot=$(findbot)
[ -n "$bot" ] || { say "❌ Kein Bot-Container gefunden (erst deployen). sudo docker ps -a zeigt, was läuft."; exit 1; }

if [ "$mode" = status ]; then
  before=${2:-unknown}
  [[ $before =~ ^(running|stopped|unknown)$ ]] || before=unknown
  for ((i = 0; i < statuswait; i++)); do d inspect "$name" >/dev/null 2>&1 || break; sleep 1; done
  if [ "$before" = running ]; then
    up=0
    for ((i = 0; i < startwait; i++)); do
      bot=$(findbot)
      if [ -n "$bot" ] && is_running "$bot"; then up=$((up + 1)); else up=0; fi
      [ "$up" -ge "$stable" ] && break
      sleep 1
    done
    if [ "$up" -lt "$stable" ]; then
      say "⚠️  Der Bot lief vorher und läuft jetzt nicht. Starten auf dem Server: sudo docker start ${bot:-<Bot-Container>}"
      exit 3
    fi
    # The run set "always" while the bot was stopped; if resetting failed (or the server restarted), say so.
    if [ "$(d inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$bot" 2>/dev/null)" = always ]; then
      say "⚠️  Neustart-Regel des Bots steht noch auf \"always\". Zurücksetzen auf dem Server: sudo docker update --restart unless-stopped $bot"
    fi
    exit 0
  fi
  is_running "$bot" && exit 0
  exit 4 # it was off before (or this run never touched it) – leave it off, do not advise starting it
fi

# ── Everything about the bot, from the bot container ──────────────────────────────────────────────────────
mount_of() { d inspect -f "{{range .Mounts}}{{if eq .Destination \"$1\"}}{{.Source}}{{end}}{{end}}" "$bot" 2>/dev/null; }
running=$(d inspect -f '{{.State.Running}}' "$bot" 2>/dev/null)
image=$(d inspect -f '{{.Image}}' "$bot" 2>/dev/null)
user=$(d inspect -f '{{.Config.User}}' "$bot" 2>/dev/null)
policy=$(d inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$bot" 2>/dev/null)
data=$(mount_of /app/.qbhost)
config=$(mount_of /app/qbhost.config.json)
[[ $running =~ ^(true|false)$ ]] || { say "❌ Zustand des Bots unklar."; exit 1; }
[[ $image =~ ^sha256:[0-9a-f]{64}$ ]] || { say "❌ Image des Bots nicht feststellbar."; exit 1; }
[[ $policy =~ ^[a-z-]*$ ]] || policy=
path_ok "$data" || { say "❌ Datenordner des Bots (/app/.qbhost) nicht feststellbar."; exit 1; }
path_ok "$config" || { say "❌ Konfiguration des Bots (/app/qbhost.config.json) nicht feststellbar."; exit 1; }
if ! [[ $user =~ ^[0-9]+:[0-9]+$ ]]; then
  user=$(d run --rm --log-driver none --network none --entrypoint stat --mount "type=bind,src=$data,dst=/d,readonly" "$image" -c %u:%g /d 2>/dev/null)
fi
[[ $user =~ ^[0-9]+:[0-9]+$ ]] || { say "❌ Besitzer des Datenordners nicht feststellbar."; exit 1; }
# Tell the Mac the state before the run (for the final check), before anything changes.
if [ "$running" = true ]; then printf 'QBBOT running\n'; else printf 'QBBOT stopped\n'; fi
# "always" while the bot is stopped brings it back after a reboot/dockerd restart mid-login. With live-restore,
# however, a dockerd restart keeps the login container running and "always" would start the bot next to it
# (two browsers on one profile) – then (or if unknown) the policy stays and the final check covers that case.
liverestore=$(d info -f '{{.LiveRestoreEnabled}}' 2>/dev/null)

# Throw-away containers: read-only image, no capabilities, no log, the bot's user. /app/.qbhost (with HOME)
# and /tmp are tmpfs – nothing of data/ is visible unless mounted explicitly below.
base=(--rm --log-driver none --user "$user" --read-only --cap-drop ALL --security-opt no-new-privileges:true
  -e QBHOST_VOICE_SETUP=off
  --tmpfs "/app/.qbhost:rw,nosuid,nodev,noexec,size=64m,mode=0700,uid=${user%%:*},gid=${user##*:}"
  --tmpfs /tmp:rw,nosuid,nodev,size=256m)
cfg=(--mount "type=bind,src=$config,dst=/app/qbhost.config.json,readonly")

# The profile directory as the bot uses it (browser.profileDir), must lie inside data/.
profile=$(d run "${base[@]}" --network none --pids-limit 128 "${cfg[@]}" "$image" \
  node_modules/.bin/tsx src/cli.ts login --print-profile-dir 2>/dev/null | tail -n 1)
if ! [[ $profile =~ ^/app/\.qbhost/[A-Za-z0-9._/-]+$ ]] || ! path_ok "$profile"; then
  say "❌ Server-Stand zu alt (kennt \"login --print-profile-dir\" nicht) oder browser.profileDir liegt nicht in data/ – erst deployen."
  exit 1
fi
rel=${profile#/app/.qbhost/}
# Never a folder the bot executes or loads from (HOME holds e.g. ~/.node_modules; voice holds the Piper venv).
case ${rel%%/*} in home | voice)
  say "❌ browser.profileDir ($profile) liegt in einem Ordner, den der Bot ausführt – bitte z. B. .qbhost/profile verwenden."
  exit 1 ;;
esac
# Helper as the bot's user, no network, fixed script, the path only as an argument: create the profile folder
# (login; a bind mount needs an existing source) and make sure no part of it is a symlink – a bind mount or
# `rm -rf` would follow it out of the profile. readlink -f resolves every component.
helper() { # helper <sh script using $1 = /d/<rel>>
  d run --rm --log-driver none --network none --user "$user" --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --mount "type=bind,src=$data,dst=/d" --entrypoint sh "$image" -c "$1" qbhost-helper "/d/$rel"
}
nolink='[ "$(readlink -f -- "$1")" = "$1" ]'
safe="{ { [ ! -e \"\$1\" ] && [ ! -L \"\$1\" ]; } || $nolink; }" # nothing there, or no symlink on the way
if [ "$mode" = login ]; then
  helper "mkdir -p -- \"\$1\" && $nolink" >/dev/null 2>&1 ||
    { say "❌ Profilordner ließ sich nicht anlegen oder ist über einen Symlink erreichbar: $data/$rel"; exit 1; }
else
  helper "$safe" >/dev/null 2>&1 || { say "❌ Profilordner ist über einen Symlink erreichbar: $data/$rel – nichts gelöscht."; exit 1; }
fi

# ── Stop the bot; from here on, cleanup starts it again ──────────────────────────────────────────────────
child=
cleaned=0
changed=0
cleanup() {
  [ "$cleaned" = 1 ] && return
  cleaned=1
  [ -n "$child" ] && kill "$child" 2>/dev/null
  d stop -t 10 "$name" >/dev/null 2>&1 # SIGTERM first: the login closes Chromium (and the profile) cleanly
  d rm -f "$name" >/dev/null 2>&1
  [ "$running" = true ] || return
  now=$(findbot)
  if [ -n "$now" ] && [ "$now" != "$bot" ]; then
    say "ℹ️  Während der Anmeldung wurde neu deployt – der neue Bot-Container hat den alten ersetzt."
    is_running "$now" || d start "$now" >/dev/null 2>&1 || say "⚠️  Bot startete nicht – auf dem Server: sudo docker start $now"
    return
  fi
  if d start "$bot" >/dev/null 2>&1; then say "▶ Bot läuft wieder."; else say "⚠️  Bot startete nicht – auf dem Server: sudo docker start $bot"; fi
  if [ "$changed" = 1 ] && ! d update --restart "$policy" "$bot" >/dev/null 2>&1; then
    say "⚠️  Neustart-Regel des Bots blieb auf \"always\". Zurücksetzen auf dem Server: sudo docker update --restart $policy $bot"
  fi
}
trap cleanup EXIT
trap 'cleanup; exit 129' HUP
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

if [ "$running" = true ]; then
  say "⏸  Stoppe den Bot …"
  if [ "$liverestore" = false ] && [ -n "$policy" ] && [ "$policy" != always ]; then
    if d update --restart always "$bot" >/dev/null 2>&1; then changed=1; else say "⚠️  Neustart-Regel des Bots unverändert."; fi
  elif [ "$liverestore" != false ]; then
    say "ℹ️  Docker live-restore aktiv (oder unbekannt): Neustart-Regel bleibt; startet der Server mitten in der Anmeldung neu, meldet es die Kontrolle am Ende."
  fi
  d stop -t 60 "$bot" >/dev/null || { say "❌ Bot ließ sich nicht stoppen."; exit 1; }
fi
d rm -f "$name" >/dev/null 2>&1

if [ "$mode" = logout ]; then
  say "🗑️  Lösche das Browser-Profil (quiz-base-Anmeldung) auf dem Server …"
  helper "$safe && rm -rf -- \"\$1\"" >/dev/null
  rc=$?
  [ $rc = 0 ] && say "✅ Profil gelöscht – der Bot ist nicht mehr bei quiz-base angemeldet."
  exit $rc
fi

say "▶ Starte den Login-Browser auf dem Server (höchstens 15 Minuten) …"
# Only the profile is writable and persistent; HOME, downloads and temp files die with the container.
# No .env, no published port, no container log (stdout carries the DevTools traffic).
# In the background + wait, so a signal runs the trap at once; stdin is passed on explicitly (the relay).
timeout -k "$grace" "$limit" sudo -n docker run -i --name "$name" "${base[@]}" --pids-limit 512 --shm-size 1g \
  --mount "type=bind,src=$data/$rel,dst=$profile" "${cfg[@]}" \
  "$image" node_modules/.bin/tsx src/cli.ts login --remote-stdio <&0 &
child=$!
wait "$child"
rc=$?
child=
exit $rc
