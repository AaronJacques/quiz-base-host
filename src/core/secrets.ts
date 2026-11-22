/**
 * Keeps secrets out of log lines that print foreign text (error messages, stacks). Secrets only ever come from the
 * environment (`.env`): the configured names (`discord.tokenEnv`, `voice.deepgram.keyEnv`), the well-known ones and
 * every variable whose name ends in TOKEN, API_KEY, SECRET or PASSWORD.
 */

/** The parts of the config that name secret environment variables (structural – core imports nothing from src). */
export interface SecretNames {
  discord?: { tokenEnv?: string };
  voice?: { deepgram?: { keyEnv?: string } };
}

const KNOWN = ['DISCORD_TOKEN', 'ANTHROPIC_API_KEY', 'DEEPGRAM_API_KEY'];
const SECRET_NAME = /(^|_)(TOKEN|API_?KEY|SECRET|PASSWORD|PASSWD)$/i;
/** Shorter values are not treated as secrets (they would blank out ordinary words). */
const MIN_LENGTH = 8;

/** Values of all secret environment variables that are set. */
export function secretValues(config: SecretNames = {}, env: NodeJS.ProcessEnv = process.env): string[] {
  const names = new Set([...KNOWN, config.discord?.tokenEnv, config.voice?.deepgram?.keyEnv].filter((n): n is string => !!n));
  for (const name of Object.keys(env)) if (SECRET_NAME.test(name)) names.add(name);
  const values: string[] = [];
  for (const name of names) {
    const v = env[name]?.trim();
    if (v && v.length >= MIN_LENGTH) values.push(v);
  }
  return values;
}

/** Replaces every secret (and each whitespace-separated part of it, e.g. the key in `Bot <token>`) in `text` with `***`. */
export function redactSecrets(text: string, secrets: (string | undefined)[]): string {
  const parts = secrets.flatMap((s) => (s ? [s, ...s.split(/\s+/)] : [])).filter((s) => s.length >= MIN_LENGTH);
  let out = text;
  for (const s of [...new Set(parts)].sort((a, b) => b.length - a.length)) out = out.split(s).join('***');
  return out;
}

/** Message and stack of an error (or the value itself) as one text, secrets removed. */
export function redactedError(e: unknown, secrets: (string | undefined)[]): string {
  const err = e as Error | null | undefined;
  const message = err?.message ?? String(e);
  const stack = typeof err?.stack === 'string' ? err.stack : '';
  const text = stack ? (stack.includes(message) ? stack : `${message}\n${stack}`) : message;
  return redactSecrets(text, secrets);
}
