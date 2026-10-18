'use strict';

// The CPU helper fails closed if its packaged fallback font is absent or not
// a TTF. Never change installed/system font configuration for this regression.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const native = process.env.CPU_NATIVE_DIR || path.join(process.cwd(), 'out/native-playback');
const bridge = require(path.join(native, 'playback-fd.node'));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-cpu-fonts-'));
const helper = path.join(temporary, 'playback-cpu-helper');
fs.copyFileSync(path.join(native, 'playback-cpu-helper'), helper);
function encode(fields) {
  const values = fields.map(value => Buffer.from(String(value)));
  const size = 4 + values.reduce((sum, value) => sum + 4 + value.length, 0);
  const bytes = Buffer.alloc(size + 4); bytes.writeUInt32LE(size); bytes.writeUInt32LE(values.length, 4);
  let offset = 8;
  for (const value of values) { bytes.writeUInt32LE(value.length, offset); offset += 4; value.copy(bytes, offset); offset += value.length; }
  return bytes;
}
async function rejectedFont() {
  const channel = bridge.createChannel();
  const child = spawn(helper, ['--stdio-v1'], {
    stdio: ['pipe', 'pipe', 'pipe', channel.childFd],
    env: { ...process.env, LD_LIBRARY_PATH: [native, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') },
  });
  bridge.close(channel.childFd);
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  child.stdin.on('error', () => {});
  const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    const completion = new Promise((resolve, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
    });
    child.stdin.end(encode(['create', 0, 0, 0, 1280, 720, 1, 'cpu']));
    assert.deepEqual(await completion, { code: 1, signal: null }, stderr);
    const messages = stdout.trim().split('\n').map(line => JSON.parse(line));
    assert(messages.some(message => message.alive === false
      && message.error === 'CPU frame subtitle font is missing or invalid'));
    assert(!stdout.includes(temporary), 'Diagnostics must not expose installation paths');
  } finally { clearTimeout(deadline); bridge.close(channel.parentFd); }
}
(async () => {
  try {
    await rejectedFont();
    fs.mkdirSync(path.join(temporary, 'fonts'));
    fs.writeFileSync(path.join(temporary, 'fonts/NotoSans-Regular.ttf'), 'wOF2invalid font fixture');
    await rejectedFont();
    console.log('CPU missing/invalid bundled font diagnostics passed');
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
