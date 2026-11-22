import { describe, expect, it } from 'vitest';
import { redactedError, redactSecrets, secretValues } from '../src/core/secrets.ts';

const TOKEN = 'MTA5ODc2NTQzMjEw.GaBcDe.discord-token-xyz';
const KEY = 'sk-ant-api03-abcdefghijklmnop';

describe('secretValues', () => {
  it('configured, well-known and *_TOKEN/*_API_KEY/*_SECRET/*_PASSWORD names; nothing short, nothing else', () => {
    const env = {
      MY_BOT_TOKEN: TOKEN,
      ANTHROPIC_API_KEY: KEY,
      CUSTOM_DG: 'dg-key-1234567890',
      SOME_SECRET: 'geheim-geheim-1',
      DB_PASSWORD: 'passwort-123456',
      SHORT_TOKEN: 'abc',
      HOME: '/home/bot-user-dir',
      QBHOST_LOG: 'info-level-x',
    };
    const v = secretValues({ discord: { tokenEnv: 'MY_BOT_TOKEN' }, voice: { deepgram: { keyEnv: 'CUSTOM_DG' } } }, env);
    expect(v.sort()).toEqual([TOKEN, KEY, 'dg-key-1234567890', 'geheim-geheim-1', 'passwort-123456'].sort());
  });

  it('the configured names count even without a secret-looking name', () => {
    expect(secretValues({ discord: { tokenEnv: 'BOTKEY' } }, { BOTKEY: TOKEN })).toEqual([TOKEN]);
  });
});

describe('redactSecrets / redactedError', () => {
  it('blanks out every occurrence, also the parts of "Bot <token>"', () => {
    expect(redactSecrets(`a ${TOKEN} b ${TOKEN}`, [TOKEN])).toBe('a *** b ***');
    expect(redactSecrets(`Authorization: Bot ${TOKEN}`, [`Bot ${TOKEN}`])).toBe('Authorization: ***');
    expect(redactSecrets(`token=${TOKEN}`, [`Bot ${TOKEN}`])).toBe('token=***');
    expect(redactSecrets('nichts drin', [undefined, ''])).toBe('nichts drin');
  });

  it('removes secrets from message AND stack', () => {
    const e = new Error(`login failed for ${TOKEN}`);
    e.stack = `Error: login failed for ${TOKEN}\n    at connect (gateway.js:1:1) token=${KEY}`;
    const out = redactedError(e, [TOKEN, KEY]);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(KEY);
    expect(out).toContain('login failed for ***');
    expect(out).toContain('at connect');
  });

  it('a stack without the message (rewritten) still reports the redacted message; plain values too', () => {
    const e = new Error(`bad ${KEY}`);
    e.stack = 'CustomStack\n    at x';
    const out = redactedError(e, [KEY]);
    expect(out).toContain('bad ***');
    expect(out).toContain('CustomStack');
    expect(redactedError(`raw ${TOKEN}`, [TOKEN])).toBe('raw ***');
    expect(redactedError(null, [TOKEN])).toBe('null');
  });
});
