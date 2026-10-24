// Test-only inspector hook. Product IPC never exposes arbitrary helper commands.
import assert from 'node:assert/strict'

export function nativeViewportProbe() {
  const value = process.env.JAVDEX_ACCEPTANCE_NATIVE_SIZE
  if (!value) return null
  assert(/^\d+x\d+$/.test(value), 'Native test size must be WIDTHxHEIGHT')
  const [width, height] = value.split('x').map(Number)
  assert([width, height].every(v => Number.isInteger(v) && v >= 1 && v <= 1024))
  return { width, height }
}

export async function installNativeViewportProbe(port, size) {
  if (!size) return
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const socket = new WebSocket(targets[0].webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  try {
    const expression = `(() => {
      const size = ${JSON.stringify(size)};
      const cp = process.getBuiltinModule('child_process'), original = cp.spawn;
      const encode = fields => {
        const values = fields.map(v => Buffer.from(v));
        const b = Buffer.alloc(8 + values.reduce((n, v) => n + 4 + v.length, 0));
        b.writeUInt32LE(b.length - 4); b.writeUInt32LE(values.length, 4);
        let p = 8;
        for (const v of values) { b.writeUInt32LE(v.length, p); p += 4; v.copy(b, p); p += v.length }
        return b;
      };
      cp.spawn = function(...args) {
        const child = original.apply(this, args);
        if (String(args[0]).endsWith('playback-dmabuf-helper')) {
          const write = child.stdin.write.bind(child.stdin);
          let verified = false;
          const ipc = process.getBuiltinModule('module').createRequire(process.execPath)('electron').ipcMain;
          const onProbe = (_event, value) => {
            if (verified || !Array.isArray(value?.samples) || value.samples.length !== 20) return;
            const color = [64, 191, 128, 255];
            if (!value.samples.every((v, i) => Math.abs(v - color[i % 4]) <= 3)) return;
            verified = true;
            write(encode(['bounds', '0', '0', String(size.width), String(size.height), '1']));
          };
          ipc.on('playback:shared-texture-self-test', onProbe);
          child.once('exit', () => ipc.removeListener('playback:shared-texture-self-test', onProbe));
          child.stdin.write = function(b, ...rest) {
            let p = 8; const fields = [];
            for (let i = 0; i < b.readUInt32LE(4); i++) {
              const n = b.readUInt32LE(p); p += 4;
              fields.push(b.toString('utf8', p, p + n)); p += n;
            }
            const start = verified && fields[0] === 'bounds' ? 1 : null;
            if (start !== null) {
              fields.splice(start, 5, '0', '0', String(size.width), String(size.height), '1');
              b = encode(fields);
            }
            return write(b, ...rest);
          };
        }
        return child;
      };
      return true;
    })()`
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Native viewport inspector timeout')), 10000)
      socket.addEventListener('message', event => {
        clearTimeout(timer)
        resolve(JSON.parse(event.data))
      }, { once: true })
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
    })
    assert.equal(reply.result?.result?.value, true, JSON.stringify(reply))
  } finally { socket.close() }
}
