#!/usr/bin/env node
// Thin launcher so `npx qbhost …` works without a build step.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tsx = path.join(root, 'node_modules', '.bin', 'tsx');
const child = spawn(tsx, [path.join(root, 'src', 'cli.ts'), ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
