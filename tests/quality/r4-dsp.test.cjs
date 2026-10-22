// 真实子进程覆盖：生成测试信号，跑 apply.mjs，验证窗外样点不变、帧数不变、非法区间被拒。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RATE = 48000;
const R4 = path.join(__dirname, '..', '..', 'packages', 'voice-out', 'quality', 'r4');

function makeWav(frames) {
  const b = Buffer.alloc(44 + frames * 2);
  b.write('RIFF', 0); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(RATE, 24); b.writeUInt32LE(RATE * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36);
  b.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) {
    // 叠加 220 Hz 与 9 kHz，便于高频分量被处理时能看到差异
    const v = 0.15 * Math.sin(2 * Math.PI * 220 * i / RATE) + 0.05 * Math.sin(2 * Math.PI * 9000 * i / RATE);
    b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), 44 + i * 2);
  }
  return b;
}

function run(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(R4, 'apply.mjs'), ...args], { windowsHide: true },
      (error, stdout, stderr) => resolve({ code: error ? 1 : 0, stdout, stderr }));
  });
}

test('R4 只改窗口内部，帧数不变', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r4-dsp-'));
  const frames = RATE * 3;
  const input = path.join(dir, 'in.wav');
  const output = path.join(dir, 'out.wav');
  fs.writeFileSync(input, makeWav(frames));
  const res = await run(['--in', input, '--out', output, '--regions',
    JSON.stringify([{ start: 1.0, end: 2.0, highFloor: 0.94 }])]);
  assert.equal(res.code, 0, res.stderr);
  const stats = JSON.parse(res.stdout.trim().split(/\r?\n/).pop());
  assert.equal(stats.outside_changed, 0);
  assert.equal(stats.frames, frames);

  const a = fs.readFileSync(input);
  const b = fs.readFileSync(output);
  assert.equal(b.length - 44, a.length - 44);
  const start = 44 + 1.0 * RATE * 2, end = 44 + 2.0 * RATE * 2;
  let outside = 0, inside = 0;
  for (let i = 44; i < a.length; i += 2) {
    const diff = a.readInt16LE(i) !== b.readInt16LE(i);
    if (i >= start && i < end) { if (diff) inside++; } else if (diff) outside++;
  }
  assert.equal(outside, 0);
  assert.ok(inside > 0, '窗口内应当有改动');
});

test('非法区间被拒绝且不写输出', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r4-dsp-bad-'));
  const input = path.join(dir, 'in.wav');
  const output = path.join(dir, 'out.wav');
  fs.writeFileSync(input, makeWav(RATE));
  const res = await run(['--in', input, '--out', output, '--regions',
    JSON.stringify([{ start: 0.1, end: 5.0 }])]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /outside|Region/i);
  assert.equal(fs.existsSync(output), false);
});

test('空区间或缺失区间被拒绝', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r4-dsp-empty-'));
  const input = path.join(dir, 'in.wav');
  const output = path.join(dir, 'out.wav');
  fs.writeFileSync(input, makeWav(RATE));
  const res = await run(['--in', input, '--out', output, '--regions', '[]']);
  assert.equal(res.code, 1);
  assert.equal(fs.existsSync(output), false);
});
