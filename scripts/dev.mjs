#!/usr/bin/env node
/**
 * dev.mjs - Dev server wrapper that reads PORT from .env
 *
 * Next.js 14 doesn't read PORT from .env files; only from the parent process env.
 * This wrapper parses .env and forwards PORT to `next dev -p <port>`.
 */

import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');

// Parse .env (lightweight, no external deps)
function loadEnv(filePath) {
  if (!existsSync(filePath)) return {};
  const env = {};
  const content = readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/i);
    if (!m) continue;
    let value = m[2].trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[m[1]] = value;
  }
  return env;
}

const envFile = resolve(projectRoot, '.env');
const fileEnv = loadEnv(envFile);

// Prefer process.env (already set), then .env, then default 3000
const port = process.env.PORT || fileEnv.PORT || '3000';

// Pass loaded env vars to child (Next.js will still load .env itself for its own vars,
// but PORT and HOSTNAME need to be in process.env before next dev binds the port).
const childEnv = { ...process.env, ...fileEnv, PORT: port };

console.log(`[dev wrapper] PORT=${port} (from ${process.env.PORT ? 'process.env' : (fileEnv.PORT ? '.env' : 'default')})`);

const nextBin = resolve(projectRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
const child = spawn(process.execPath, [nextBin, 'dev', '-p', port], {
  cwd: projectRoot,
  env: childEnv,
  stdio: 'inherit',
});

child.on('exit', (code) => process.exit(code ?? 0));