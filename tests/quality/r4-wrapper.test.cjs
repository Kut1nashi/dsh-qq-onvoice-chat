'use strict';
// Mock only child execution; assert real WAV replacement and preservation on disk.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..', 'packages', 'voice-out', 'quality', 'r4');
function load(execFile) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'r4.cjs'), 'utf8'), {
    module, exports: module.exports, __dirname: root, process, Buffer,
    require: (name) => name === 'node:child_process' ? { execFile } : require(name),
  }, { filename: 'r4.cjs' });
  return module.exports;
}
function wav(frames = 4800, marker = 0) {
  const b = Buffer.alloc(44 + frames * 2);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(48000, 24); b.writeUInt32LE(96000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36);
  b.writeUInt32LE(frames * 2, 40); b.writeInt16LE(marker, 44);
  return b;
}
async function runCase(mode) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r4-test-'));
  // In POSIX a literal Windows-style component reproduces the same JSON escape.
  const dir = path.join(tmp, process.platform === 'win32' ? 'needy-voice' : 'D:\\needy-voice');
  fs.mkdirSync(dir);
  const input = path.join(dir, 'speech.wav');
  const original = wav();
  fs.writeFileSync(input, original);
  const fake = (_exe, args, _opts, callback) => {
    const out = args[args.indexOf('--out') + 1];
    fs.writeFileSync(out, wav(mode === 'wrong-frames' ? 4700 : 4800, 7));
    const stats = { ok: true, input, output: out, frames: 4800, outside_changed: 0 };
    let stdout = 'worker log\r\n' + JSON.stringify(stats) + '\r\n';
    if (mode === 'empty') stdout = '';
    if (mode === 'invalid-json') stdout = '{bad json}';
    if (mode === 'not-ok') stdout = JSON.stringify({ ...stats, ok: false });
    if (mode === 'wrong-input') stdout = JSON.stringify({ ...stats, input: 'another-file.wav' });
    if (mode === 'outside-change') stdout = JSON.stringify({ ...stats, outside_changed: 1 });
    queueMicrotask(() => callback(mode === 'timeout' ? new Error('timeout') : null, stdout, ''));
    return { unref() {} };
  };
  try {
    const result = await load(fake).applyR4(input, [{ start: .01, end: .02 }]);
    if (mode === 'success') {
      assert.equal(result.applied, true, result.reason);
      assert.deepEqual(fs.readFileSync(input), wav(4800, 7));
    } else {
      assert.equal(result.applied, false);
      assert.deepEqual(fs.readFileSync(input), original);
    }
    assert.deepEqual(fs.readdirSync(dir), ['speech.wav']);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

test('Windows backslash+n in JSON paths survives CRLF and log lines', () => runCase('success'));
for (const mode of ['empty', 'invalid-json', 'not-ok', 'wrong-input', 'wrong-frames', 'outside-change', 'timeout']) {
  test(`worker ${mode} preserves prior WAV and removes temporary file`, () => runCase(mode));
}
test('missing regions never starts a worker', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r4-no-region-'));
  const input = path.join(tmp, 'input.wav'); fs.writeFileSync(input, wav());
  try {
    const { applyR4 } = load(() => { throw new Error('unexpected worker'); });
    assert.equal((await applyR4(input, [])).reason, 'no-regions');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
