import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { encodeAudioFile, cleanupTemp } from '../packages/voice-out/lib/voice-core.js';

const require = createRequire(import.meta.url);
const engineSource = fs.readFileSync(new URL('../packages/voice-out/engines/tts-core.cjs', import.meta.url), 'utf8');
const bridgeSource = fs.readFileSync(new URL('../packages/voice-out/bridge/voice-out.tts.js', import.meta.url), 'utf8');
const sendSource = fs.readFileSync(new URL('../packages/voice-out/bridge/voice-out.core.js', import.meta.url), 'utf8');

function wav(seconds, { sampleRate = 32000, channels = 1, bits = 16 } = {}) {
  const frames = seconds === undefined ? 1 : Math.round(sampleRate * seconds);
  const blockAlign = channels * bits / 8;
  const size = frames * blockAlign;
  const out = Buffer.alloc(44 + size + size % 2);
  out.write('RIFF'); out.writeUInt32LE(out.length - 8, 4); out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(sampleRate, 24); out.writeUInt32LE(sampleRate * blockAlign, 28);
  out.writeUInt16LE(blockAlign, 32); out.writeUInt16LE(bits, 34);
  out.write('data', 36); out.writeUInt32LE(size, 40);
  return out;
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function childProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.exitCode = null; child.signalCode = null; child.kills = 0;
  child.kill = () => {
    child.kills += 1; child.signalCode = 'SIGTERM';
    child.emit('exit', null, 'SIGTERM'); child.emit('close', null, 'SIGTERM');
  };
  return child;
}

function engine(t, { fetch = async () => new Response(null, { status: 400 }), spawn, env = {}, files = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-tts-test-'));
  for (const [file, data] of Object.entries({
    'GPT-SoVITS/runtime/python.exe': '', 'GPT-SoVITS/api_v2.py': '',
    'GPT-SoVITS/GPT_SoVITS/configs/tts_infer.yaml': '', 'ref/sally_ref.wav': wav(),
    'ref/sally_ref.txt': '参考\n 原文', ...files
  })) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), data);
  }
  const module = { exports: {} };
  const children = [];
  const calls = [];
  const mockSpawn = (...args) => {
    calls.push(args);
    const child = spawn ? spawn(...args) : childProcess();
    children.push(child);
    return child;
  };
  vm.runInNewContext(engineSource, {
    module, __dirname: root, process: { env }, Buffer, URL, AbortSignal, AbortController,
    setTimeout, clearTimeout, console, fetch,
    require: (id) => id === 'child_process' ? { spawn: mockSpawn } : require(id)
  }, { filename: 'tts-core.cjs' });
  const api = module.exports;
  t.after(() => { api.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { api, root, children, calls };
}

test('probe treats every HTTP response as port liveness and cancels bodies', async (t) => {
  for (const status of [200, 400, 405, 422, 404, 500, 503]) {
    let cancelled = false;
    const { api } = engine(t, { fetch: async () => ({
      status, ok: status === 200, body: { cancel: async () => { cancelled = true; } }
    }) });
    assert.equal(await api.probe(), true);
    assert.equal(cancelled, true);
  }
  const offline = engine(t, { fetch: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(await offline.api.probe(), false);
  const cancelFailed = engine(t, { fetch: async () => ({ status: 500, body: {
    cancel: async () => { throw new Error('body already closed'); }
  } }) });
  assert.equal(await cancelFailed.api.probe(), true);
});

test('real HTTP GET 500 reuses the external endpoint; POST success and errors never spawn a duplicate', async (t) => {
  let posts = 0;
  const server = createServer((req, res) => {
    req.resume();
    if (req.method === 'POST' && ++posts === 1) {
      res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(wav());
    } else {
      res.writeHead(500); res.end('model not ready');
    }
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  } catch (error) {
    if (error.code !== 'EPERM' || process.env.CI) throw error;
    t.skip('sandbox forbids loopback listening; this HTTP transport case must also pass in CI/on the model host');
    return;
  }
  t.after(() => {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    return closed;
  });
  const { api, calls } = engine(t, { fetch: globalThis.fetch, env: { VOICE_TTS_PORT: String(server.address().port) } });
  assert.equal(await api.probe(), true);
  assert.equal((await api.ensureServer()).started, false);
  assert.equal((await api.synthesize('你好')).bytes, wav().length);
  await assert.rejects(api.synthesize('重试'), /TTS HTTP 500.*model not ready/);
  api.stop();
  assert.equal(calls.length, 0);
  assert.equal(server.listening, true);
});

test('existing external server is reused and never terminated by stop', async (t) => {
  const { api, calls } = engine(t, { fetch: async (_, opts) => opts.method === 'POST'
    ? new Response(wav()) : new Response(null, { status: 500 }) });
  const ready = await api.ensureServer();
  assert.equal(ready.started, false);
  assert.equal((await api.synthesize('已有服务')).bytes, wav().length);
  api.stop();
  assert.equal(calls.length, 0);
});

test('concurrent warmups share one startup and stop only the managed child', async (t) => {
  let probes = 0;
  const gate = deferred();
  const { api, calls, children } = engine(t, { fetch: async () => {
    if (++probes === 1) { await gate.promise; throw new Error('offline'); }
    return new Response(null, { status: 400 });
  } });
  const first = api.ensureServer(); const second = api.ensureServer();
  gate.resolve();
  const results = await Promise.all([first, second]);
  assert.equal(calls.length, 1);
  assert.equal(results[0].started, true);
  assert.equal(results[1].started, true);
  api.stop();
  assert.equal(children[0].kills, 1);
});

test('spawn error is a rejection, failed startup is cleaned up, and retry works', async (t) => {
  let online = false;
  const { api, children } = engine(t, {
    fetch: async () => {
      if (online) return new Response(null, { status: 400 });
      await delay(1); throw new Error('offline');
    },
    spawn: () => {
      const child = childProcess();
      queueMicrotask(() => child.emit('error', new Error('ENOENT python')));
      return child;
    }
  });
  await assert.rejects(api.ensureServer({ waitMs: 1000 }), /ENOENT python/);
  assert.equal(children[0].kills, 1);
  online = true;
  assert.equal(await api.warmup(), true);
});

test('an unhealthy managed server does not spawn duplicates or lose its process handle', async (t) => {
  let probes = 0; let degraded = false;
  const { api, calls, children } = engine(t, { fetch: async () => {
    if (++probes === 1 || degraded) throw new Error('offline');
    return new Response(null, { status: 400 });
  } });
  await api.ensureServer();
  degraded = true;
  await assert.rejects(api.ensureServer(), /服务进程仍在运行但探活失败/);
  assert.equal(calls.length, 1);
  assert.equal(children[0].kills, 0);
  degraded = false;
  assert.equal(await api.warmup(), true);
  api.stop();
  assert.equal(children[0].kills, 1);
});

test('process exit by signal fails startup and does not poll until the deadline', async (t) => {
  const { api } = engine(t, {
    fetch: async () => { await delay(1); throw new Error('offline'); },
    spawn: () => {
      const child = childProcess();
      queueMicrotask(() => { child.signalCode = 'SIGKILL'; child.emit('exit', null, 'SIGKILL'); });
      return child;
    }
  });
  await assert.rejects(api.ensureServer({ waitMs: 1000 }), /TTS 服务启动失败/);
});

test('startup timeout terminates the owned process', async (t) => {
  const { api, children } = engine(t, { fetch: async () => { throw new Error('offline'); } });
  await assert.rejects(api.ensureServer({ waitMs: 30 }), /启动超时/);
  assert.equal(children.length, 1);
  assert.equal(children[0].kills, 1);
});

test('stop cancels an in-flight startup probe without spawning afterward', async (t) => {
  const entered = deferred();
  const { api, calls } = engine(t, { fetch: async (_, { signal }) => {
    entered.resolve();
    await delay(10000, undefined, { signal });
  } });
  const startup = api.ensureServer();
  await entered.promise;
  api.stop();
  await assert.rejects(startup, /启动已取消/);
  assert.equal(calls.length, 0);
});

test('directory file and executable environment overrides work without editing source', (t) => {
  const configured = engine(t, { files: { 'gsv-dir.txt': '/configured\nignored' } });
  assert.equal(configured.api.GSV_DIR, path.resolve('/configured'));
  const overridden = engine(t, { env: {
    VOICE_TTS_GSV_DIR: '/override', VOICE_TTS_PYTHON: '/python', VOICE_TTS_FFMPEG: '/ffmpeg'
  }, files: { 'gsv-dir.txt': '/ignored' } });
  assert.equal(overridden.api.GSV_DIR, path.resolve('/override'));
  assert.equal(overridden.api.PY, '/python');
  assert.equal(overridden.api.FFMPEG, '/ffmpeg');
});

test('synthesis sends JSON POST and writes the returned WAV with a unique absolute path', async (t) => {
  const requests = [];
  const { api } = engine(t, { fetch: async (url, opts) => {
    requests.push({ url: String(url), ...opts });
    return opts.method === 'POST' ? new Response(wav()) : new Response(null, { status: 400 });
  } });
  const text = '你好 & ? #\n世界'.repeat(500);
  const first = await api.synthesize(` ${text} `, { promptText: '参考\n 原文', splitMethod: 'cut2', minAudioSeconds: 0 });
  const second = await api.synthesize('再次合成');
  const request = requests.find((r) => r.method === 'POST');
  const payload = JSON.parse(request.body);
  assert.equal(request.url, 'http://127.0.0.1:9880/tts');
  assert.equal(request.headers['content-type'], 'application/json');
  assert.equal(payload.text, text);
  assert.equal(payload.prompt_text, '参考 原文');
  assert.equal(payload.text_split_method, 'cut2');
  assert.equal(payload.streaming_mode, false);
  assert.equal(payload.batch_size, 1);
  assert.equal(path.isAbsolute(payload.ref_audio_path), true);
  assert.equal(path.isAbsolute(first.path), true);
  assert.notEqual(first.path, second.path);
  assert.deepEqual(fs.readFileSync(first.path), wav());
  assert.equal(first.bytes, wav().length);
});

test('missing, empty or whitespace-only default reference text fails before any network or startup work', async (t) => {
  for (const text of [null, '', ' \n\t\uFEFF ']) {
    let fetched = false;
    const { api, root, calls } = engine(t, { fetch: async () => { fetched = true; },
      files: { 'ref/sally_ref.txt': text ?? '' } });
    if (text === null) fs.unlinkSync(path.join(root, 'ref/sally_ref.txt'));
    assert.equal(api.available(), false);
    assert.equal(api.needsReference(), true);
    await assert.rejects(api.synthesize('你好'), /V3\/v4.*ref\/sally_ref.txt.*promptText/);
    assert.equal(fetched, false);
    assert.equal(calls.length, 0);
  }
});

test('an explicit reference transcript works without the default text file; explicit empty text is rejected', async (t) => {
  const { api, root } = engine(t, { fetch: async (_, opts) => {
    if (opts.method !== 'POST') return new Response(null, { status: 500 });
    assert.equal(JSON.parse(opts.body).prompt_text, '同一音频原文');
    return new Response(wav());
  } });
  assert.equal(api.available(), true);
  assert.equal(api.needsReference(), false);
  await assert.rejects(api.synthesize('你好', { promptText: ' \n ' }), /缺少参考原文/);
  fs.unlinkSync(path.join(root, 'ref/sally_ref.txt'));
  assert.equal((await api.synthesize('你好', { promptText: ' 同一音频原文 ' })).bytes, wav().length);
});

test('empty input, missing reference and invalid limits fail before network work', async (t) => {
  let fetched = false;
  const { api } = engine(t, { fetch: async () => { fetched = true; } });
  await assert.rejects(api.synthesize('  '), /文本为空/);
  await assert.rejects(api.synthesize('test', { refAudio: '/missing-ref.wav' }), /参考音频不存在/);
  for (const options of [{ timeoutMs: -1 }, { maxBytes: Infinity }, { queueTimeoutMs: 0 }, { startTimeoutMs: NaN },
    { minAudioSeconds: -1 }, { minAudioSeconds: Infinity }, { minAudioSeconds: NaN }]) {
    await assert.rejects(api.synthesize('test', options), /必须是/);
  }
  assert.equal(fetched, false);
});

test('a 0.32-second fragment for long text is rejected before saving; short replies and later synthesis still work', async (t) => {
  const fragment = wav(0.32, { sampleRate: 48000 });
  assert.equal(fragment.length, 30764);
  const results = [fragment, fragment, wav(2.72, { sampleRate: 48000 })];
  const { api, root, calls } = engine(t, { fetch: async (_, opts) => opts.method === 'POST'
    ? new Response(results.shift()) : new Response(null, { status: 500 }) });
  await assert.rejects(api.synthesize('这是一段应该被完整读出的中文文本。'), /音频异常过短.*0\.320秒.*HTTP 200.*30764B/);
  assert.equal(fs.existsSync(path.join(root, 'out')), false);
  assert.equal((await api.synthesize('嗯。')).seconds, 0.32);
  assert.equal((await api.synthesize('这是一段应该被完整读出的中文文本。')).seconds, 2.72);
  assert.equal(calls.length, 0);
});

test('duration guard distinguishes longer text from punctuation, short acknowledgements and one English word', async (t) => {
  const { api } = engine(t, { fetch: async (_, opts) => opts.method === 'POST'
    ? new Response(wav(0.32)) : new Response(null, { status: 400 }) });
  assert.equal((await api.synthesize('你好，！！！😀😀😀😀😀😀😀😀😀😀')).seconds, 0.32);
  assert.equal((await api.synthesize('understanding', { textLang: 'en' })).seconds, 0.32);
  await assert.rejects(api.synthesize('one two three four five six seven eight nine ten', { textLang: 'en' }), /音频异常过短/);
  await assert.rejects(api.synthesize('1234567890'), /音频异常过短/);
  assert.equal((await api.synthesize('1234567890', { minAudioSeconds: 0 })).seconds, 0.32);
  assert.equal((await api.synthesize('1234567890', { minAudioSeconds: 0.2 })).seconds, 0.32);
});

test('WAV duration follows data frames across channel/rate/bit-depth variants and ignores padded metadata', async (t) => {
  const audio = wav(1.25, { sampleRate: 44100, channels: 2, bits: 24 });
  const metadata = Buffer.alloc(10); metadata.write('JUNK'); metadata.writeUInt32LE(1, 4);
  const padded = Buffer.concat([audio.subarray(0, 12), metadata, audio.subarray(12)]);
  padded.writeUInt32LE(padded.length - 8, 4);
  const { api } = engine(t, { fetch: async (_, opts) => opts.method === 'POST'
    ? new Response(padded) : new Response(null, { status: 400 }) });
  assert.equal((await api.synthesize('这是一段正常长度的测试用中文文本。')).seconds, 1.25);
  const fragment = wav(0.32);
  const largeMetadata = Buffer.alloc(65544); largeMetadata.write('JUNK'); largeMetadata.writeUInt32LE(65536, 4);
  const large = Buffer.concat([fragment, largeMetadata]); large.writeUInt32LE(large.length - 8, 4);
  const oversized = engine(t, { fetch: async (_, opts) => opts.method === 'POST'
    ? new Response(large) : new Response(null, { status: 400 }) });
  await assert.rejects(oversized.api.synthesize('这是一段应该被完整读出的中文文本。'), /音频异常过短.*0\.320秒/);
});

test('empty, truncated and inconsistent WAV data blocks are refused and the slot recovers', async (t) => {
  const original = wav(1);
  const empty = original.subarray(0, 44); empty.writeUInt32LE(0, 40);
  const badRate = wav(1); badRate.writeUInt32LE(1, 28);
  const badAlign = wav(1); badAlign.writeUInt16LE(3, 32);
  const partial = wav(1).subarray(0, 50);
  const responses = [empty, badRate, badAlign, partial, wav(1)];
  const { api, root } = engine(t, { fetch: async (_, opts) => opts.method === 'POST'
    ? new Response(responses.shift()) : new Response(null, { status: 400 }) });
  for (let i = 0; i < 4; i++) await assert.rejects(api.synthesize('检查'), /无效 WAV/);
  assert.equal(fs.existsSync(path.join(root, 'out')), false);
  assert.equal((await api.synthesize('恢复')).seconds, 1);
});

test('inference warmup is opt-in, sends one real synthesis request and removes its generated WAV', async (t) => {
  const posts = [];
  const { api, root } = engine(t, { fetch: async (_, opts) => {
    if (opts.method !== 'POST') return new Response(null, { status: 500 });
    posts.push(JSON.parse(opts.body)); return new Response(wav(2.72));
  } });
  assert.equal(await api.warmup(), true);
  assert.equal(posts.length, 0);
  const outDir = path.join(root, 'warmup');
  assert.equal(await api.warmup({ text: '这是一段用于检查语音合成状态的预热文本。',
    promptLang: 'ja', outDir, waitMs: 1000 }), true);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].prompt_lang, 'ja');
  assert.deepEqual(fs.readdirSync(outDir), []);
});

test('failed inference warmup returns false, logs the fragment and leaves no artifact or stuck model slot', async (t) => {
  let posts = 0; const logs = [];
  const { api, root } = engine(t, { fetch: async (_, opts) => opts.method === 'POST'
    ? new Response(wav(++posts === 1 ? 0.32 : 2.72)) : new Response(null, { status: 500 }) });
  assert.equal(await api.warmup({ text: '这是一段用于检查语音合成状态的预热文本。', log: (line) => logs.push(line) }), false);
  assert.ok(logs.some((line) => /预热失败.*音频异常过短/.test(line)));
  assert.equal(fs.existsSync(path.join(root, 'out')), false);
  assert.equal((await api.synthesize('恢复')).seconds, 2.72);
});

test('external supervision mode never spawns on failure and recovers by reusing the supervisor endpoint', async (t) => {
  let online = false;
  const { api, calls } = engine(t, { env: { VOICE_TTS_AUTO_START: 'false' }, fetch: async (_, opts) => {
    if (!online) throw new Error('offline');
    return opts.method === 'POST' ? new Response(wav(2.72)) : new Response(null, { status: 500 });
  } });
  assert.equal(api.AUTO_START, false);
  await assert.rejects(api.ensureServer(), /按需启动已关闭/);
  assert.equal(await api.warmup({ text: '这是一段用于检查语音合成状态的预热文本。' }), false);
  online = true;
  assert.equal((await api.ensureServer()).started, false);
  assert.equal(await api.warmup({ text: '这是一段用于检查语音合成状态的预热文本。' }), true);
  api.stop();
  assert.equal(calls.length, 0);
});

test('output directory failure releases the model slot for later synthesis', async (t) => {
  const { api } = engine(t, { fetch: async (_, opts) => opts.method === 'POST'
    ? new Response(wav()) : new Response(null, { status: 400 }) });
  await assert.rejects(api.synthesize('test', { outDir: api.DEFAULT_REF }));
  assert.equal((await api.synthesize('retry')).bytes, wav().length);
});

test('HTTP errors, empty and non-WAV responses leave no output; next request can succeed', async (t) => {
  const responses = [new Response('model unavailable', { status: 500 }), new Response(null),
    new Response('{"error":"oops"}'), new Response(Buffer.alloc(100)), new Response(wav())];
  const { api, root } = engine(t, { fetch: async (_, opts) =>
    opts.method === 'POST' ? responses.shift() : new Response(null, { status: 400 }) });
  await assert.rejects(api.synthesize('test'), /TTS HTTP 500.*model unavailable/);
  for (let i = 0; i < 3; i++) await assert.rejects(api.synthesize('test'), /无效 WAV/);
  assert.equal(fs.existsSync(path.join(root, 'out')), false);
  assert.equal((await api.synthesize('test')).bytes, wav().length);
});

test('response size limit covers content-length and chunked streams', async (t) => {
  for (const declared of [true, false]) {
    let cancelled = false;
    const { api, root } = engine(t, { fetch: async (_, opts) => {
      if (opts.method !== 'POST') return new Response(null, { status: 400 });
      return new Response(new ReadableStream({
        pull(controller) { controller.enqueue(Buffer.alloc(64)); },
        cancel() { cancelled = true; }
      }), { headers: declared ? { 'content-length': '128' } : {} });
    } });
    await assert.rejects(api.synthesize('test', { maxBytes: 100 }), /音频超过上限/);
    assert.equal(cancelled, true);
    assert.equal(fs.existsSync(path.join(root, 'out')), false);
  }
});

test('error response diagnostics are bounded and the unread body is cancelled', async (t) => {
  let cancelled = false;
  const { api } = engine(t, { fetch: async (_, opts) => opts.method !== 'POST'
    ? new Response(null, { status: 400 })
    : new Response(new ReadableStream({
      pull(controller) { controller.enqueue(Buffer.alloc(8192, 65)); },
      cancel() { cancelled = true; }
    }), { status: 500 }) });
  await assert.rejects(api.synthesize('test'), (error) => {
    assert.match(error.message, /TTS HTTP 500/);
    assert.ok(error.message.length < 400);
    return true;
  });
  assert.equal(cancelled, true);
});

test('inference timeout includes response body reading and releases the queue', async (t) => {
  let first = true;
  const { api } = engine(t, { fetch: async (_, opts) => {
    if (opts.method !== 'POST') return new Response(null, { status: 400 });
    if (!first) return new Response(wav());
    first = false;
    return new Response(new ReadableStream({
      start(controller) {
        opts.signal.addEventListener('abort', () => controller.error(opts.signal.reason), { once: true });
      }
    }));
  } });
  // AbortSignal.timeout itself is unref'ed; keep a normal timer alive for this mock stream.
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(api.synthesize('test', { timeoutMs: 30 }), /timeout|aborted/i); }
  finally { clearTimeout(keepAlive); }
  assert.equal((await api.synthesize('retry')).bytes, wav().length);
});

test('concurrent synthesis is FIFO and never overlaps model requests', async (t) => {
  let active = 0; let maximum = 0;
  const order = [];
  const { api } = engine(t, { fetch: async (_, opts) => {
    if (opts.method !== 'POST') return new Response(null, { status: 400 });
    active += 1; maximum = Math.max(maximum, active);
    order.push(JSON.parse(opts.body).text);
    await delay(5); active -= 1;
    return new Response(wav());
  } });
  const outputs = await Promise.all(['one', 'two', 'three'].map((text) => api.synthesize(text)));
  assert.equal(maximum, 1);
  assert.deepEqual(order, ['one', 'two', 'three']);
  assert.equal(new Set(outputs.map((out) => out.path)).size, 3);
});

test('timings separate queue wait, server readiness, HTTP and file saving', async (t) => {
  const entered = deferred(); const gate = deferred();
  let posts = 0;
  const { api } = engine(t, { fetch: async (_, opts) => {
    if (opts.method !== 'POST') { await delay(3); return new Response(null, { status: 400 }); }
    if (++posts === 1) { entered.resolve(); await gate.promise; }
    await delay(3);
    return new Response(wav());
  } });
  const first = api.synthesize('first');
  await entered.promise;
  const second = api.synthesize('second');
  await delay(25); gate.resolve();
  const results = await Promise.all([first, second]);
  assert.ok(results[1].timings.queueMs >= 20);
  for (const { timings } of results) {
    for (const value of Object.values(timings)) assert.ok(Number.isFinite(value) && value >= 0);
    assert.ok(Math.abs(timings.queueMs + timings.slotMs - timings.totalMs) < 0.01);
    assert.ok(Math.abs(timings.serverMs + timings.requestMs + timings.saveMs - timings.slotMs) < 0.01);
  }
});

test('queued requests expire without reaching the model', async (t) => {
  const gate = deferred(); const entered = deferred(); const requests = [];
  const { api } = engine(t, { fetch: async (_, opts) => {
    if (opts.method !== 'POST') return new Response(null, { status: 400 });
    requests.push(JSON.parse(opts.body).text); entered.resolve();
    await gate.promise;
    return new Response(wav());
  } });
  const first = api.synthesize('first');
  await entered.promise;
  await assert.rejects(api.synthesize('expired', { queueTimeoutMs: 30 }), /排队超时/);
  gate.resolve();
  await first;
  await api.synthesize('next');
  assert.deepEqual(requests, ['first', 'next']);
});

test('queue has a fixed capacity and stop rejects all pending requests', async (t) => {
  const gate = deferred(); const entered = deferred();
  const { api } = engine(t, { fetch: async (_, opts) => {
    if (opts.method !== 'POST') return new Response(null, { status: 400 });
    entered.resolve(); await gate.promise;
    return new Response(wav());
  } });
  const first = api.synthesize('first');
  await entered.promise;
  const queued = Array.from({ length: 8 }, () => api.synthesize('pending'));
  const settled = Promise.allSettled(queued);
  await assert.rejects(api.synthesize('overflow'), /队列已满/);
  api.stop();
  const results = await settled;
  assert.equal(results.every((r) => r.status === 'rejected' && /服务已停止/.test(r.reason.message)), true);
  gate.resolve(); await first;
});

test('ffmpeg failure cannot report an old reference file as newly cut audio', async (t) => {
  const { api, root } = engine(t, { spawn: () => {
    const child = childProcess();
    queueMicrotask(() => { child.stderr.emit('data', Buffer.from('bad input')); child.emit('close', 1); });
    return child;
  } });
  const source = path.join(root, 'source.mp4'); fs.writeFileSync(source, 'test');
  await assert.rejects(api.cutReference(source, 0, 5), /切片失败.*bad input/);
});

function bridge(overrides = {}) {
  const cleaned = []; const sent = [];
  let commits = 0;
  const context = {
    path, ttsCoreLoaded: true,
    ttsCoreModule: { available: () => true, synthesize: async () => ({ path: '/tmp/generated.wav', bytes: 46 }) },
    voiceCfg: () => ({ enabled: true, maxBytes: 1000, tts: { replyProbability: 1 } }),
    shouldBlockSilentReply: () => false,
    getSocialV2State: () => ({ recentMessages: [] }),
    voiceBudgetCheck: () => {}, voiceBudgetCommit: () => { commits += 1; },
    resolveVoicePathForOperator: (p) => ({ path: p }),
    sendVoiceV2: async (...args) => { sent.push(args); },
    cleanupTemp: (p, temporary) => cleaned.push({ p, temporary }),
    log: () => {}, appendActivity: () => {}, ...overrides
  };
  context.sendVoiceV2.supportsInlineAudio = true;
  vm.createContext(context);
  // 参考片段原本嵌在 ESM bridge.js 中；vm Script 用常量代替 import.meta.url。
  vm.runInContext(bridgeSource.replace('import.meta.url', JSON.stringify(import.meta.url)), context,
    { filename: 'voice-out.tts.js' });
  return { reply: context.maybeReplyAsVoiceV2, cleaned, sent, commits: () => commits };
}

test('bridge applies the slow-host defaults, keeps explicit budgets and skips replies over the text limit', async () => {
  const options = [];
  const adapter = { available: () => true, synthesize: async (_, opts) => {
    options.push(opts); return { path: '/tmp/generated.wav', bytes: 46 };
  } };
  const b = bridge({ ttsCoreModule: adapter });
  assert.equal((await b.reply('private:123', '文'.repeat(81))).reason, 'too-long');
  assert.equal(options.length, 0);
  assert.equal((await b.reply('private:123', '文'.repeat(80))).sent, true);
  assert.equal(options[0].queueTimeoutMs, 90000);
  assert.equal(options[0].startTimeoutMs, 300000);
  assert.equal(options[0].timeoutMs, 120000);
  assert.equal(options[0].minAudioSeconds, 1);
  const configured = bridge({ ttsCoreModule: adapter, voiceCfg: () => ({ tts: {
    replyProbability: 1, maxChars: 100, queueTimeoutMs: 60000, startTimeoutMs: 240000, timeoutMs: 200000, minAudioSeconds: 0
  } }) });
  assert.equal((await configured.reply('private:123', '文'.repeat(81))).sent, true);
  assert.equal(options[1].queueTimeoutMs, 60000);
  assert.equal(options[1].startTimeoutMs, 240000);
  assert.equal(options[1].timeoutMs, 200000);
  assert.equal(options[1].minAudioSeconds, 0);
});

test('bridge cleans up generated files after successful send and commits once', async () => {
  const b = bridge();
  assert.equal((await b.reply('private:123', 'test')).sent, true);
  assert.equal(b.sent.length, 1);
  assert.equal(b.commits(), 1);
  assert.deepEqual(b.cleaned, [{ p: '/tmp/generated.wav', temporary: true }]);
});

test('bridge cleans up after failed sends and returns text fallback', async () => {
  const b = bridge({ sendVoiceV2: async () => { throw new Error('gateway offline'); } });
  assert.equal((await b.reply('private:123', 'test')).sent, false);
  assert.equal(b.commits(), 0);
  assert.equal(b.cleaned.length, 1);
});

test('bridge catches adapter availability and synthesis errors', async () => {
  for (const adapter of [
    { available: () => { throw new Error('bad config'); }, synthesize: async () => {} },
    { available: () => true, synthesize: async () => { throw new Error('queue full'); } },
    { synthesize: async () => {} }
  ]) {
    const b = bridge({ ttsCoreModule: adapter });
    assert.equal((await b.reply('private:123', 'test')).sent, false);
    assert.equal(b.sent.length, 0);
  }
});

test('bridge rechecks silence and budget after a slow synthesis and releases its file', async () => {
  let silenceChecks = 0;
  const silent = bridge({ shouldBlockSilentReply: () => ++silenceChecks > 1 });
  assert.equal((await silent.reply('private:123', 'test')).reason, 'silent');
  assert.equal(silent.sent.length, 0);
  assert.equal(silent.cleaned.length, 1);
  let budgetChecks = 0;
  const limited = bridge({ voiceBudgetCheck: () => { if (++budgetChecks > 1) throw new Error('rate limit'); } });
  assert.equal((await limited.reply('private:123', 'test')).sent, false);
  assert.equal(limited.sent.length, 0);
  assert.equal(limited.cleaned.length, 1);
});

test('probability miss and preflight rate limit skip loading the engine', async () => {
  const b = bridge({ ttsCoreLoaded: false,
    voiceCfg: () => ({ tts: { replyProbability: 0 } }) });
  assert.equal((await b.reply('private:123', 'test')).reason, 'probability');
  const limited = bridge({ ttsCoreLoaded: false, voiceBudgetCheck: () => { throw new Error('limit'); } });
  assert.equal((await limited.reply('private:123', 'test')).reason, 'rate-limit');
});

test('voice messages still trigger synthesis when ordinary text probability is zero', async () => {
  const b = bridge({
    voiceCfg: () => ({ tts: { replyProbability: 0 } }),
    getSocialV2State: () => ({ recentMessages: [
      { isSelf: false, text: '[语音：你好]' }, { isSelf: true, text: '自己的文本' }
    ] })
  });
  const result = await b.reply('private:123', 'test');
  assert.equal(result.sent, true);
  assert.equal(result.via, 'voice-message');
});

test('disabling TTS during synthesis prevents sending and cleans the generated file', async () => {
  let reads = 0;
  const b = bridge({ voiceCfg: () => ({ enabled: true, tts: { replyProbability: 1, enabled: ++reads === 1 } }) });
  assert.equal((await b.reply('private:123', 'test')).reason, 'disabled');
  assert.equal(b.sent.length, 0);
  assert.equal(b.cleaned.length, 1);
});

test('voiceCfg preserves the configured TTS module and queue timeout', () => {
  const tts = { module: 'configured-core.cjs', queueTimeoutMs: 45000 };
  const ctx = { cfg: { socialV2: { voice: { tts } } }, ROOT: os.tmpdir(), path, process: { env: {} } };
  vm.createContext(ctx); vm.runInContext(sendSource, ctx);
  assert.equal(ctx.voiceCfg().tts, tts);
  assert.equal(ctx.voiceCfg().tts.queueTimeoutMs, 45000);
});

test('TTS fragment falls back before synthesis when a legacy sender ignores inline audio', async () => {
  let synthesized = false;
  const ctx = {
    path, voiceCfg: () => ({ tts: { replyProbability: 1 } }),
    shouldBlockSilentReply: () => false, getSocialV2State: () => ({ recentMessages: [] }),
    voiceBudgetCheck: () => {}, log: () => {}, sendVoiceV2: async () => {},
    ttsCoreLoaded: true, ttsCoreModule: { available: () => true, synthesize: async () => { synthesized = true; } }
  };
  vm.createContext(ctx); vm.runInContext(bridgeSource.replace('import.meta.url', JSON.stringify(import.meta.url)), ctx);
  assert.equal((await ctx.maybeReplyAsVoiceV2('private:123', 'test')).reason, 'sender-no-inline');
  assert.equal(synthesized, false);
});

test('inline snapshot remains readable after original file cleanup and respects byte limits', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-inline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'source.wav');
  fs.writeFileSync(file, wav());
  await assert.rejects(encodeAudioFile(file, { maxBytes: wav().length - 1 }), /超过上限/);
  await assert.rejects(encodeAudioFile(file, { maxBytes: Infinity }), /正整数/);
  const snapshot = await encodeAudioFile(file, { maxBytes: wav().length });
  cleanupTemp(file, true);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(Buffer.from(snapshot.slice('base64://'.length), 'base64'), wav());
  fs.writeFileSync(file, '');
  await assert.rejects(encodeAudioFile(file), /快照为空/);
});

test('20 TTS replies keep audio bytes available to a gateway reading after HTTP acknowledgement', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-deferred-gateway-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const payloads = []; const created = [];
  let nextId = 0;
  const cfg = { socialV2: { voice: { enabled: true, maxPerMinute: 0, maxPerHour: 0,
    tts: { enabled: true, replyProbability: 1, queueTimeoutMs: 45000 } } }, snowluma: {} };
  const ctx = {
    fs, path, ROOT: dir, cfg, process: { env: {} }, sendChain: Promise.resolve(), voiceSendTimes: new Map(),
    encodeAudioFile, cleanupTemp, AbortSignal,
    log: () => {}, appendActivity: () => {}, shouldBlockSilentReply: () => false,
    getSocialV2State: () => ({ recentMessages: [] }),
    assertOutboundAuditOk: () => {}, captureSendGuard: () => () => {},
    inspectAudio: async (file) => ({ ok: true, size: fs.statSync(file).size, duration: 1, warnings: [] }),
    describeAudio: () => 'test wave',
    processAudioVolume: async (file) => {
      const converted = file + '.converted.wav'; fs.copyFileSync(file, converted); created.push(converted);
      return { path: converted, converted: true, volume: 1, loudness: null, mode: 'original' };
    },
    fetch: async (_, options) => {
      const message = JSON.parse(options.body).message;
      payloads.push(message[0].data.file);
      // 返回时不读取音频，在全部文件被清理后才模拟网关消费。
      return new Response(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: payloads.length } }));
    },
    ttsCoreLoaded: true,
    ttsCoreModule: { available: () => true, synthesize: async (_, options) => {
      assert.equal(options.queueTimeoutMs, 45000);
      const file = path.join(dir, `tts-${++nextId}.wav`); fs.writeFileSync(file, wav()); created.push(file);
      return { path: file, bytes: wav().length };
    } }
  };
  vm.createContext(ctx); vm.runInContext(sendSource, ctx);
  // 测试已生成的可信本地文件；不使用操作者路径解析里的其它外部函数。
  ctx.resolveVoicePathForOperator = (file) => ({ path: file });
  vm.runInContext(bridgeSource.replace('import.meta.url', JSON.stringify(import.meta.url)), ctx);
  const replies = await Promise.all(Array.from({ length: 20 }, () => ctx.maybeReplyAsVoiceV2('private:123', '测试')));
  assert.equal(replies.every((r) => r.sent === true), true);
  assert.equal(payloads.length, 20);
  assert.equal(created.every((file) => !fs.existsSync(file)), true);
  await delay(10);
  for (const payload of payloads) {
    assert.ok(payload.startsWith('base64://'));
    assert.deepEqual(Buffer.from(payload.slice(9), 'base64'), wav());
  }
});
