'use strict';
/**
 * 本地语音合成核心：文本 → wav（GPT-SoVITS v4，零样本音色克隆）。
 *
 * 设计照抄隔壁 voice-stt/stt-core.cjs 的范式：
 *   - 所有依赖（GPT-SoVITS 整合包、运行时、模型、ffmpeg）都在本机固定路径上，
 *     桥接只按绝对路径 require 本文件，qq-bridge-main 里不装任何东西；
 *   - 对外只暴露几个函数，内部自己管 HTTP 服务的生命周期；
 *   - 任何一步失败都抛错，由调用方决定退回文本（绝不吞掉回复）。
 *
 * 服务形态：GPT-SoVITS 自带 api_v2.py 是 FastAPI，合成走 GET/POST /tts：
 *   text / text_lang / ref_audio_path / prompt_text / prompt_lang / media_type…
 * 实测启动参数：-a 绑定地址（默认 127.0.0.1）、-p 端口（默认 9880）、-c 配置文件。
 *
 * 参考音频（音色来源）放本目录 ref/ 下：
 *   - ref/sally_ref.wav   —— 必填，3~10 秒、单人、无 BGM/混响的干净人声
 *   - ref/sally_ref.txt   —— 必填：该段音频对应的逐字原文（V3/v4 需要非空 prompt_text）
 * 用 cutReference() 可以从番剧文件里切出参考片段。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const { setTimeout: delay } = require('timers/promises');
const { performance } = require('perf_hooks');

const ROOT = __dirname;
const REF_DIR = path.join(ROOT, 'ref');
const OUT_DIR = path.join(ROOT, 'out');

// GPT-SoVITS 整合包位置：环境变量 → gsv-dir.txt → 同级 ./GPT-SoVITS。
// 代码里**不含任何本机绝对路径**，换机器不用改源码。
function configuredDirectory() {
  try { return fs.readFileSync(path.join(ROOT, 'gsv-dir.txt'), 'utf8').split(/\r?\n/u)[0].trim(); }
  catch { return ''; }
}
const GSV_DIR = path.resolve(String(process.env.VOICE_TTS_GSV_DIR || '').trim() || configuredDirectory()
  || path.join(ROOT, 'GPT-SoVITS'));
const PY = process.env.VOICE_TTS_PYTHON || path.join(GSV_DIR, 'runtime', 'python.exe');
const API = path.join(GSV_DIR, 'api_v2.py');
const FFMPEG = process.env.VOICE_TTS_FFMPEG || path.join(GSV_DIR, 'ffmpeg.exe');
const CFG = path.join(GSV_DIR, 'GPT_SoVITS', 'configs', 'tts_infer.yaml');

const DEFAULT_REF = path.join(REF_DIR, 'sally_ref.wav');
const DEFAULT_REF_TEXT_FILE = path.join(REF_DIR, 'sally_ref.txt');

const HOST = process.env.VOICE_TTS_HOST || '127.0.0.1';
const PORT = Number(process.env.VOICE_TTS_PORT || 9880);
const BASE = `http://${HOST}:${PORT}`;

let serverProc = null;
let serverStarting = null;
let startupController = null;
const synthesisQueue = [];
let synthesizing = false;
const MAX_PENDING = 8;

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0 || n > 2147483647) {
    throw new Error(`${name} 必须是 1~2147483647 的整数`);
  }
  return n;
}

function exists(f) {
  try { return fs.existsSync(f); } catch { return false; }
}

/** 默认整合包/运行时/配置/参考音频与非空原文是否齐备。 */
function available() {
  return exists(PY) && exists(API) && exists(CFG) && exists(DEFAULT_REF) && Boolean(referenceText());
}

/** 运行依赖齐备，但缺参考音频或非空原文时为 true。 */
function needsReference() {
  return exists(PY) && exists(API) && exists(CFG) && (!exists(DEFAULT_REF) || !referenceText());
}

function referenceText() {
  try {
    return fs.readFileSync(DEFAULT_REF_TEXT_FILE, 'utf8').replace(/\s+/gu, ' ').trim();
  } catch {
    return '';
  }
}

/** 仅探测 HTTP 存活，不验证推理能力：部分 api_v2 的裸 GET /tts 返回 500。
 * 任一 HTTP 响应都说明端口已被占用，不能据此再启动进程；业务错误由合成 POST 透传。
 */
async function probe(timeoutMs = 2500, signal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  try {
    const res = await fetch(`${BASE}/tts`, { signal: controller.signal });
    try { await res.body?.cancel(); } catch {} // 已收到响应，释放响应体失败也不能触发重复启动。
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

/**
 * 确保端口有 HTTP 响应；连接失败时尝试启动本地服务。
 * 默认给模型加载预留 5 分钟；具体冷启动耗时需在部署机器上验证。
 * @param {{log?: Function, waitMs?: number}} [options]
 * @returns {Promise<{ok: boolean, started: boolean, ms?: number}>}
 */
async function ensureServer(options = {}) {
  if (serverStarting) return serverStarting;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const waitMs = positiveInteger(options.waitMs, 300000, 'waitMs');
  const controller = new AbortController();
  startupController = controller;
  let child = null;
  serverStarting = (async () => {
    const t0 = Date.now();
    const remaining = () => Math.max(1, waitMs - (Date.now() - t0));
    const checkStopped = () => {
      if (controller.signal.aborted) throw new Error('TTS 服务启动已取消');
    };
    const ready = await probe(Math.min(2500, remaining()), controller.signal);
    checkStopped();
    if (ready) return { ok: true, started: false };
    if (serverProc && serverProc.exitCode === null && serverProc.signalCode == null) {
      throw new Error('TTS 服务进程仍在运行但探活失败，请检查服务日志');
    }
    if (Date.now() - t0 >= waitMs) throw new Error(`TTS 服务启动超时（${waitMs}ms）`);
    for (const f of [PY, API, CFG]) {
      if (!exists(f)) throw new Error(`缺少 GPT-SoVITS 文件：${f}`);
    }
    log(`[tts] 启动 GPT-SoVITS 服务 ${HOST}:${PORT} …`);
    child = spawn(PY, [API, '-a', HOST, '-p', String(PORT), '-c', CFG], {
      cwd: GSV_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    serverProc = child;
    let spawnError = null;
    let exited = false;
    let tail = '';
    const eat = (d) => { tail = (tail + d.toString()).slice(-4000); };
    child.stdout.on('data', eat);
    child.stderr.on('data', eat);
    child.on('error', (error) => { spawnError = error; });
    child.on('exit', (code) => {
      exited = true;
      log(`[tts] 服务进程退出，code=${code}`);
      if (serverProc === child) serverProc = null;
    });

    while (Date.now() - t0 < waitMs) {
      checkStopped();
      const ready = await probe(Math.min(2500, remaining()), controller.signal);
      checkStopped();
      if (spawnError) throw new Error(`TTS 服务启动失败：${spawnError.message}`);
      if (exited || child.exitCode !== null || child.signalCode != null) {
        throw new Error(`TTS 服务启动失败（code=${child.exitCode}）：${tail.slice(-400)}`);
      }
      if (ready) {
        const ms = Date.now() - t0;
        log(`[tts] 服务就绪，用时 ${ms}ms`);
        return { ok: true, started: true, ms };
      }
      await delay(Math.min(1500, remaining()), undefined, { signal: controller.signal });
    }
    throw new Error(`TTS 服务启动超时（${waitMs}ms）：${tail.slice(-400)}`);
  })().catch((error) => {
    if (child) {
      try { child.kill(); } catch {}
      if (serverProc === child) serverProc = null;
    }
    throw error;
  }).finally(() => {
    if (startupController === controller) startupController = null;
    serverStarting = null;
  });

  return serverStarting;
}

/** 预热：确保服务有 HTTP 响应；不执行推理，首次合成仍可能有模型预热开销。 */
async function warmup(options = {}) {
  try {
    await ensureServer(options);
    return true;
  } catch {
    return false;
  }
}

/**
 * 文本 → wav 文件。
 * @param {string} text 要合成的文本（简体中文走 textLang 'zh'）。
 * @param {{refAudio?: string, promptText?: string, promptLang?: string, textLang?: string,
 *   splitMethod?: string, timeoutMs?: number, startTimeoutMs?: number,
 *   queueTimeoutMs?: number, maxBytes?: number, outDir?: string, log?: Function}} [options]
 * @returns {Promise<{path: string, bytes: number, ms: number, timings: object}>}
 */
async function synthesize(text, options = {}) {
  const clean = String(text ?? '').trim();
  if (!clean) throw new Error('要合成的文本为空');
  const refAudio = options.refAudio || DEFAULT_REF;
  if (!exists(refAudio)) {
    throw new Error(`参考音频不存在：${refAudio}（把干净人声放到 ref/sally_ref.wav）`);
  }
  const promptText = String(options.promptText ?? referenceText()).replace(/\s+/gu, ' ').trim();
  if (!promptText) {
    throw new Error('缺少参考原文：GPT-SoVITS V3/v4 需要非空 prompt_text，请填写 ref/sally_ref.txt 或传入 promptText（与参考音频逐字对应）');
  }
  const timeoutMs = positiveInteger(options.timeoutMs, 120000, 'timeoutMs');
  const queueTimeoutMs = positiveInteger(options.queueTimeoutMs, 90000, 'queueTimeoutMs');
  const startTimeoutMs = positiveInteger(options.startTimeoutMs, 300000, 'startTimeoutMs');
  const maxBytes = positiveInteger(options.maxBytes, 20 * 1024 * 1024, 'maxBytes');
  const queuedAt = performance.now();
  const release = await acquireSynthesis(queueTimeoutMs);
  const acquiredAt = performance.now();
  try {
    await ensureServer({ log: options.log, waitMs: startTimeoutMs });
    const readyAt = performance.now();

    const payload = {
      text: clean,
      text_lang: options.textLang || 'zh',
      ref_audio_path: path.resolve(refAudio),
      prompt_text: promptText,
      prompt_lang: options.promptLang || 'zh',
      text_split_method: options.splitMethod || 'cut5',
      batch_size: 1,
      media_type: 'wav',
      streaming_mode: false
    };

    const t0 = Date.now();
    const res = await fetch(`${BASE}/tts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) {
      const body = await readBody(res, 4096, true);
      throw new Error(`TTS HTTP ${res.status}：${body.toString('utf8').slice(0, 300)}`);
    }
    const buf = await readBody(res, maxBytes);
    if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF'
      || buf.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error('TTS 返回无效 WAV 音频');
    }
    const receivedAt = performance.now();
    const outDir = path.resolve(options.outDir || OUT_DIR);
    await fs.promises.mkdir(outDir, { recursive: true });
    const out = path.join(outDir, `tts-${randomUUID()}.wav`);
    try { await fs.promises.writeFile(out, buf, { flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST') await fs.promises.unlink(out).catch(() => {});
      throw error;
    }
    const savedAt = performance.now();
    const elapsed = (start, end) => Math.round((end - start) * 1000) / 1000;
    return { path: out, bytes: buf.length, ms: Date.now() - t0, timings: {
      queueMs: elapsed(queuedAt, acquiredAt),
      serverMs: elapsed(acquiredAt, readyAt),
      requestMs: elapsed(readyAt, receivedAt),
      saveMs: elapsed(receivedAt, savedAt),
      slotMs: elapsed(acquiredAt, savedAt),
      totalMs: elapsed(queuedAt, savedAt)
    } };
  } finally {
    release();
  }
}

// GPT-SoVITS 共用模型与参考音频状态：同一适配器内串行推理，排队过久退回文本。
function acquireSynthesis(timeoutMs) {
  if (!synthesizing) {
    synthesizing = true;
    return Promise.resolve(releaseSynthesis);
  }
  if (synthesisQueue.length >= MAX_PENDING) return Promise.reject(new Error('TTS 合成队列已满'));
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject, timer: null };
    entry.timer = setTimeout(() => {
      synthesisQueue.splice(synthesisQueue.indexOf(entry), 1);
      reject(new Error(`TTS 合成排队超时（${timeoutMs}ms）`));
    }, timeoutMs);
    synthesisQueue.push(entry);
  });
}

function releaseSynthesis() {
  const next = synthesisQueue.shift();
  if (next) {
    clearTimeout(next.timer);
    next.resolve(releaseSynthesis);
  } else synthesizing = false;
}

async function readBody(res, maxBytes, truncate = false) {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  let bytes = 0;
  const chunks = [];
  try {
    const declared = Number(res.headers.get('content-length'));
    if (!truncate && declared > maxBytes) throw new Error(`TTS 音频超过上限（${maxBytes}B）`);
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (bytes + value.byteLength > maxBytes) {
        if (!truncate) throw new Error(`TTS 音频超过上限（${maxBytes}B）`);
        chunks.push(Buffer.from(value.subarray(0, maxBytes - bytes)));
        break;
      }
      chunks.push(Buffer.from(value));
      bytes += value.byteLength;
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// 参考音频制作（从番剧源文件里切片）
// ---------------------------------------------------------------------------

function runFfmpeg(args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    } catch (error) {
      resolve({ code: -1, stderr: String(error?.message ?? error) });
      return;
    }
    let stderr = '';
    let timer = null;
    child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-4000); });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stderr: String(e?.message ?? e) });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stderr });
    });
    timer = setTimeout(() => {
      try { child.kill(); } catch {}
      resolve({ code: -2, stderr: `ffmpeg 超时（${timeoutMs}ms）` });
    }, timeoutMs);
  });
}

/**
 * 从任意音视频文件里切一段当参考音频：转成单声道 wav。
 * @param {string} srcFile 源文件（番剧 mkv/mp4/wav…）
 * @param {number} startSec 起始秒
 * @param {number} durSec 时长秒（建议 3~10）
 * @param {{outFile?: string, sampleRate?: number}} [options]
 * @returns {Promise<{path: string, bytes: number, seconds: number}>}
 */
async function cutReference(srcFile, startSec, durSec, options = {}) {
  if (!exists(srcFile)) throw new Error(`源文件不存在：${srcFile}`);
  fs.mkdirSync(REF_DIR, { recursive: true });
  const out = options.outFile || DEFAULT_REF;
  const rate = Number(options.sampleRate) || 32000;
  const r = await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(startSec), '-t', String(durSec), '-i', srcFile,
    '-vn', '-ac', '1', '-ar', String(rate), '-f', 'wav', out
  ]);
  if (r.code !== 0 || !exists(out)) throw new Error(`切片失败：${r.stderr.trim().slice(0, 300)}`);
  const stat = fs.statSync(out);
  if (!stat.size) throw new Error('切片失败：输出音频为空');
  return { path: out, bytes: stat.size, seconds: Number(durSec) };
}

/** 去掉参考音频里的背景音乐/伴奏（uvr5 权重在整合包里，先用包内自带模型）。 */
async function separateVocals(srcFile, options = {}) {
  const outDir = options.outDir || path.join(ROOT, 'ref', 'separated');
  fs.mkdirSync(outDir, { recursive: true });
  const r = await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y', '-i', srcFile,
    '-af', 'afftdn=nf=-25', '-ac', '1', '-ar', '32000',
    path.join(outDir, path.basename(srcFile).replace(/\.[^.]+$/u, '') + '_denoise.wav')
  ]);
  if (r.code !== 0) throw new Error(`降噪失败：${r.stderr.trim().slice(0, 300)}`);
  const out = path.join(outDir, path.basename(srcFile).replace(/\.[^.]+$/u, '') + '_denoise.wav');
  return { path: out, bytes: fs.statSync(out).size };
}

/** 关掉本模块拉起的服务进程（不动别人起的）。 */
function stop() {
  startupController?.abort();
  for (const entry of synthesisQueue.splice(0)) {
    clearTimeout(entry.timer);
    entry.reject(new Error('TTS 服务已停止'));
  }
  if (serverProc) {
    try { serverProc.kill(); } catch {}
    serverProc = null;
  }
}

module.exports = {
  synthesize,
  ensureServer,
  warmup,
  available,
  needsReference,
  referenceText,
  cutReference,
  separateVocals,
  probe,
  stop,
  GSV_DIR,
  PY,
  FFMPEG,
  REF_DIR,
  DEFAULT_REF
};

// 命令行自测：node tts-core.cjs "要合成的文本"
if (require.main === module) {
  (async () => {
    const text = process.argv.slice(2).join(' ') || '这是一条语音回复测试。';
    console.log('available =', available());
    console.log('needsReference =', needsReference());
    try {
      const out = await synthesize(text, { log: console.log });
      console.log('OK', JSON.stringify(out));
    } catch (error) {
      console.error('FAIL', error?.message ?? error);
      process.exitCode = 1;
    } finally {
      stop();
    }
  })();
}
