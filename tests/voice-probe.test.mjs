import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { probeAudio as realProbeAudio,
  DEFAULT_MAX_BYTES, DEFAULT_MAX_SECONDS, isAudioFile, formatBytes, formatDuration
} from '../packages/voice-out/lib/voice-core.js';

const realSpawn = childProcess.spawn;
const fakeProbe = fileURLToPath(new URL('./fixtures/fake-ffprobe.mjs', import.meta.url));
const source = fs.readFileSync(new URL('../packages/voice-out/lib/voice-core.js', import.meta.url), 'utf8');
const functionSource = ['probeAudio', 'inspectAudio'].map((name) => {
  const match = source.match(new RegExp('^export async function ' + name + '\\b[\\s\\S]*?^\\}$', 'm'));
  assert.ok(match, name);
  return match[0].replace('export ', '');
}).join('\n');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-probe-test-'));
  const file = path.join(root, '日语 sample.wav');
  fs.writeFileSync(file, Buffer.alloc(100));
  const tmpDir = path.join(root, 'probe');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, file, tmpDir };
}

function mockProbe(t, mode = 'normal') {
  const calls = [];
  const spawn = (command, args, options) => {
    const env = { ...process.env, DSH_TEST_PROBE_MODE: mode };
    // This child emulates a CLI, not another node:test worker.
    delete env.NODE_TEST_CONTEXT;
    const child = realSpawn(process.execPath, [fakeProbe, ...args], {
      ...options, env
    });
    calls.push({ command, args, options, child });
    return child;
  };
  // Execute the exact exported functions with a CLI dependency substitute, without
  // changing node:child_process or the test runner's own live ESM bindings.
  const api = vm.runInNewContext(functionSource + '\n({probeAudio, inspectAudio})', {
    fs, os, path, spawn, process: { pid: process.pid, env: {} }, setTimeout, clearTimeout,
    DEFAULT_MAX_BYTES, DEFAULT_MAX_SECONDS, isAudioFile, formatBytes, formatDuration,
    SILK_EXTS: new Set(['.silk', '.slk'])
  });
  return { ...api, calls };
}

function noOutputs(tmpDir) {
  assert.deepEqual(fs.readdirSync(tmpDir), []);
}

test('legacy ffprobe prints JSON to an inherited file descriptor without -o or pipes', async (t) => {
  const f = fixture(t); const { calls, probeAudio } = mockProbe(t);
  const result = await probeAudio(f.file, { ffprobePath: 'legacy-ffprobe', tmpDir: f.tmpDir });
  assert.deepEqual({ ...result }, { ok: true, duration: 3.25, formatName: 'wav', codec: 'pcm_s16le', sampleRate: 16000, channels: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.includes('-o'), false);
  assert.deepEqual([calls[0].options.stdio[0], calls[0].options.stdio[2]], ['ignore', 'ignore']);
  assert.equal(typeof calls[0].options.stdio[1], 'number');
  noOutputs(f.tmpDir);
});

test('Unicode and spaces remain one input argument', async (t) => {
  const f = fixture(t); const { calls, probeAudio } = mockProbe(t);
  assert.equal((await probeAudio(f.file, { tmpDir: f.tmpDir })).ok, true);
  assert.equal(calls[0].args.at(-1), f.file);
  noOutputs(f.tmpDir);
});

test('inspectAudio enforces maxSeconds with the legacy probe', async (t) => {
  const f = fixture(t); const { inspectAudio } = mockProbe(t);
  const result = await inspectAudio(f.file, { ffprobePath: 'legacy-ffprobe', maxSeconds: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.duration, 3.25);
  assert.match(result.error, /超过上限/);
});

test('inspectAudio accepts the exact duration limit without a probe warning', async (t) => {
  const f = fixture(t); const { inspectAudio } = mockProbe(t);
  const result = await inspectAudio(f.file, { ffprobePath: 'legacy-ffprobe', maxSeconds: 3.25 });
  assert.equal(result.ok, true);
  assert.equal(result.duration, 3.25);
  assert.equal(result.warnings.length, 0);
});

test('a failed probe cannot turn partial JSON into success', async (t) => {
  const f = fixture(t); const { probeAudio } = mockProbe(t, 'nonzero');
  const result = await probeAudio(f.file, { tmpDir: f.tmpDir });
  assert.equal(result.ok, false);
  assert.match(result.reason, /退出码.*1/);
  noOutputs(f.tmpDir);
});

test('invalid JSON is reported and removed', async (t) => {
  const f = fixture(t); const { probeAudio } = mockProbe(t, 'invalid');
  const result = await probeAudio(f.file, { tmpDir: f.tmpDir });
  assert.equal(result.ok, false);
  assert.match(result.reason, /解析失败/);
  noOutputs(f.tmpDir);
});

test('empty stdout is reported and removed', async (t) => {
  const f = fixture(t); const { probeAudio } = mockProbe(t, 'empty');
  const result = await probeAudio(f.file, { tmpDir: f.tmpDir });
  assert.equal(result.ok, false);
  assert.match(result.reason, /结果为空/);
  noOutputs(f.tmpDir);
});

test('probe JSON is bounded before reading into memory', async (t) => {
  const f = fixture(t); const { probeAudio } = mockProbe(t, 'large');
  const result = await probeAudio(f.file, { tmpDir: f.tmpDir });
  assert.equal(result.ok, false);
  assert.match(result.reason, /超过上限/);
  noOutputs(f.tmpDir);
});

test('timeout terminates the child before temporary output cleanup', async (t) => {
  const f = fixture(t); const { calls, probeAudio } = mockProbe(t, 'timeout');
  const result = await probeAudio(f.file, { tmpDir: f.tmpDir, timeoutMs: 100 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /超时/);
  assert.ok(calls[0].child.exitCode !== null || calls[0].child.signalCode !== null);
  noOutputs(f.tmpDir);
});

test('an unavailable executable releases the output file', async (t) => {
  const f = fixture(t);
  const result = await realProbeAudio(f.file, { ffprobePath: path.join(f.root, 'missing-ffprobe'), tmpDir: f.tmpDir });
  assert.equal(result.ok, false);
  assert.match(result.reason, /不可用/);
  noOutputs(f.tmpDir);
});

test('synchronous spawn failure releases the output file', async (t) => {
  const f = fixture(t);
  const result = await realProbeAudio(f.file, { ffprobePath: null, tmpDir: f.tmpDir });
  assert.equal(result.ok, false);
  assert.match(result.reason, /启动失败/);
  noOutputs(f.tmpDir);
});

test('unusable preferred temporary directory falls back to the system directory', async (t) => {
  const f = fixture(t); const { probeAudio } = mockProbe(t);
  const result = await probeAudio(f.file, { tmpDir: f.file });
  assert.equal(result.ok, true);
});

test('probe failures retain the documented inspectAudio warning policy', async (t) => {
  const f = fixture(t); const { inspectAudio } = mockProbe(t, 'nonzero');
  const result = await inspectAudio(f.file, { ffprobePath: 'legacy-ffprobe' });
  assert.equal(result.ok, true);
  assert.equal(result.duration, null);
  assert.match(result.warnings[0], /不做时长校验/);
});
