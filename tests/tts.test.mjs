import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { encodeAudioFile, cleanupTemp } from '../packages/voice-out/lib/voice-core.js';

const require = createRequire(import.meta.url);
const engineSource = fs.readFileSync(new URL('../packages/voice-out/engines/tts-core.cjs', import.meta.url), 'utf8');
const bridgeSource = fs.readFileSync(new URL('../packages/voice-out/bridge/voice-out.tts.js', import.meta.url), 'utf8');
const sendSource = fs.readFileSync(new URL('../packages/voice-out/bridge/voice-out.core.js', import.meta.url), 'utf8');

function wav() {
  const out = Buffer.alloc(46);
  out.write('RIFF'); out.writeUInt32LE(38, 4); out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(32000, 24); out.writeUInt32LE(64000, 28);
  out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36); out.writeUInt32LE(2, 40);
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

test('probe accepts validation responses, rejects failed endpoints, and cancels bodies', async (t) => {
  for (const status of [200, 400, 422, 404, 500, 503]) {
    let cancelled = false;
    const { api } = engine(t, { fetch: async () => ({
      status, ok: status === 200, body: { cancel: async () => { cancelled = true; } }
    }) });
    assert.equal(await api.probe(), [200, 400, 422].includes(status));
    assert.equal(cancelled, true);
  }
});

test('existing external server is reused and never terminated by stop', async (t) => {
  const { api, calls } = engine(t);
  const ready = await api.ensureServer();
  assert.equal(ready.started, false);
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
    if (++probes === 1) throw new Error('offline');
    return new Response(null, { status: degraded ? 500 : 400 });
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
  const first = await api.synthesize(` ${text} `, { promptText: '', splitMethod: 'cut2' });
  const second = await api.synthesize('再次合成');
  const request = requests.find((r) => r.method === 'POST');
  const payload = JSON.parse(request.body);
  assert.equal(request.url, 'http://127.0.0.1:9880/tts');
  assert.equal(request.headers['content-type'], 'application/json');
  assert.equal(payload.text, text);
  assert.equal(payload.prompt_text, '');
  assert.equal(payload.text_split_method, 'cut2');
  assert.equal(payload.streaming_mode, false);
  assert.equal(payload.batch_size, 1);
  assert.equal(path.isAbsolute(payload.ref_audio_path), true);
  assert.equal(path.isAbsolute(first.path), true);
  assert.notEqual(first.path, second.path);
  assert.deepEqual(fs.readFileSync(first.path), wav());
  assert.equal(first.bytes, wav().length);
});

test('empty input, missing reference and invalid limits fail before network work', async (t) => {
  let fetched = false;
  const { api } = engine(t, { fetch: async () => { fetched = true; } });
  await assert.rejects(api.synthesize('  '), /文本为空/);
  await assert.rejects(api.synthesize('test', { refAudio: '/missing-ref.wav' }), /参考音频不存在/);
  for (const options of [{ timeoutMs: -1 }, { maxBytes: Infinity }, { queueTimeoutMs: 0 }, { startTimeoutMs: NaN }]) {
    await assert.rejects(api.synthesize('test', options), /必须是/);
  }
  assert.equal(fetched, false);
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
