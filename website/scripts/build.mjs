#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepare } from './prepare.mjs';

await prepare({ offline: process.argv.includes('--offline') });
const root = fileURLToPath(new URL('../../', import.meta.url));
const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build', '--workspace', '@javdex/website'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' } });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
await import('./check.mjs');
