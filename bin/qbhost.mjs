#!/usr/bin/env node
// Thin launcher so `npx qbhost …` works without a build step.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tsx = path.join(root, 'node_modules', '.bin', 'tsx');
const child = spawn(tsx, [path.join(root, 'src', 'cli.ts'), ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
// Ctrl+C reaches the child too (same process group) – wait while it shuts down (and says goodbye)
// instead of handing the terminal back early. A plain `kill` of this launcher is passed on.
process.on('SIGINT', () => {});
process.on('SIGTERM', () => child.kill('SIGTERM'));
