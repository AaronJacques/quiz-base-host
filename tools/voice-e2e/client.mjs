#!/usr/bin/env node
// Player tool for the voice test. The player only *hears* the host (its audio is transcribed
// with Whisper) and *speaks* via macOS TTS – exactly the audio path a human would use.
//   node client.mjs listen <Anna|Ben>        wait for the host to speak, print what was heard
//   node client.mjs say <Anna|Ben> "<text>"  say something into the voice room
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const [cmd, name, ...rest] = process.argv.slice(2);
const ROOM = 'http://127.0.0.1:4790';
const HARNESS = 'http://127.0.0.1:4791';
const STT = 'http://127.0.0.1:8178/inference';
const DIR = '.qbhost/voice-e2e';
const VOICES = { Anna: 'Anna', Ben: 'Reed (Deutsch (Deutschland))' };
mkdirSync(DIR, { recursive: true });
// Position in the bot's speech; the harness deletes these files at start.
const stateFile = `${DIR}/seq-${name}.txt`;

async function status() {
  try { return await (await fetch(`${HARNESS}/status`)).json(); } catch { return { over: true, phase: 'harness-down' }; }
}

if (cmd === 'say') {
  const text = rest.join(' ');
  const wav = `${DIR}/say-${name}.wav`;
  execFileSync('say', ['-v', VOICES[name], '-o', wav, '--file-format=WAVE', '--data-format=LEI16@16000', text]);
  const r = await fetch(`${ROOM}/speak?id=u-${name.toLowerCase()}&name=${name}`, { method: 'POST', body: readFileSync(wav) });
  console.log(r.ok ? `(gesagt: "${text}")` : `FEHLER ${r.status}`);
} else if (cmd === 'listen') {
  let seq = existsSync(stateFile) ? Number(readFileSync(stateFile, 'utf8')) : 0;
  const heard = [];
  const deadline = Date.now() + 90_000;
  // Wait for the host to start speaking, then until it has been quiet for 3 s.
  while (Date.now() < deadline) {
    const wait = heard.length ? 3000 : Math.min(20_000, deadline - Date.now());
    const { items } = await (await fetch(`${ROOM}/played?after=${seq}&wait=${wait}`)).json();
    if (!items.length) {
      if (heard.length) break;
      const st = await status();
      if (st.over) break;
      continue;
    }
    for (const it of items) {
      const wav = Buffer.from(await (await fetch(`${ROOM}/played/${it.seq}.wav`)).arrayBuffer());
      const form = new FormData();
      form.set('file', new Blob([wav], { type: 'audio/wav' }), 'a.wav');
      form.set('response_format', 'json');
      form.set('language', 'de');
      const { text } = await (await fetch(STT, { method: 'POST', body: form })).json();
      heard.push(String(text).trim());
      seq = it.seq;
      // Wait for the sentence to finish "playing" before reporting.
      const left = it.at + it.ms - Date.now();
      if (left > 0) await new Promise((r) => setTimeout(r, left));
    }
    writeFileSync(stateFile, String(seq));
  }
  const st = await status();
  console.log(heard.length ? heard.map((h) => `HOST: ${h}`).join('\n') : '(Stille)');
  if (st.over) console.log('### SPIEL VORBEI ###');
} else {
  console.log('usage: listen <name> | say <name> "<text>"');
}
