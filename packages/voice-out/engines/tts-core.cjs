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
 *   - ref/sally_ref.txt   —— 强烈建议：该段音频对应的原文（零样本克隆给了明显更稳）
 * 用 cutReference() 可以从番剧文件里切出参考片段。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const REF_DIR = path.join(ROOT, 'ref');
const OUT_DIR = path.join(ROOT, 'out');

// GPT-SoVITS 整合包位置：环境变量优先，否则用与本文件同级的 ./GPT-SoVITS。
// 代码里**不含任何本机绝对路径**，换机器不用改源码。
const GSV_DIR = String(process.env.VOICE_TTS_GSV_DIR || '').trim()
  || path.join(ROOT, 'GPT-SoVITS');
const PY = path.join(GSV_DIR, 'runtime', 'python.exe');
const API = path.join(GSV_DIR, 'api_v2.py');
const FFMPEG = path.join(GSV_DIR, 'ffmpeg.exe');
const CFG = path.join(GSV_DIR, 'GPT_SoVITS', 'configs', 'tts_infer.yaml');

const DEFAULT_REF = path.join(REF_DIR, 'sally_ref.wav');
const DEFAULT_REF_TEXT_FILE = path.join(REF_DIR, 'sally_ref.txt');

const HOST = process.env.VOICE_TTS_HOST || '127.0.0.1';
const PORT = Number(process.env.VOICE_TTS_PORT || 9880);
const BASE = `http://${HOST}:${PORT}`;

let serverProc = null;
let serverStarting = null;

function exists(f) {
  try { return fs.existsSync(f); } catch { return false; }
}

/** 整合包/运行时/配置/参考音频是否齐备。 */
function available() {
  return exists(PY) && exists(API) && exists(CFG) && exists(DEFAULT_REF);
}

/** 只差参考音频时为 true —— 用来给用户一句明确的提示。 */
function needsReference() {
  return exists(PY) && exists(API) && exists(CFG) && !exists(DEFAULT_REF);
}

function referenceText() {
  try {
    return fs.readFileSync(DEFAULT_REF_TEXT_FILE, 'utf8').replace(/\s+/gu, ' ').trim();
  } catch {
    return '';
  }
}

/** 服务探活：只要 HTTP 端口有响应就算活着（少参数时它回 400，也算活着）。 */
async function probe(timeoutMs = 2500) {
  try {
    await fetch(`${BASE}/tts`, { signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

/**
 * 确保 TTS 服务在跑；不在就拉起来并等它 ready。
 * 首次启动要加载模型，实测较慢（几十秒级），所以等待上限给了 3 分钟。
 * @param {{log?: Function, waitMs?: number}} [options]
 * @returns {Promise<{ok: boolean, started: boolean, ms?: number}>}
 */
async function ensureServer(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const waitMs = Number(options.waitMs) || 180000;
  if (await probe()) return { ok: true, started: false };
  if (serverStarting) return serverStarting;

  serverStarting = (async () => {
    for (const f of [PY, API, CFG]) {
      if (!exists(f)) throw new Error(`缺少 GPT-SoVITS 文件：${f}`);
    }
    log(`[tts] 启动 GPT-SoVITS 服务 ${HOST}:${PORT} …`);
    const child = spawn(PY, [API, '-a', HOST, '-p', String(PORT), '-c', CFG], {
      cwd: GSV_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    serverProc = child;
    let tail = '';
    const eat = (d) => { tail = (tail + d.toString()).slice(-4000); };
    child.stdout.on('data', eat);
    child.stderr.on('data', eat);
    child.on('exit', (code) => {
      log(`[tts] 服务进程退出，code=${code}`);
      if (serverProc === child) serverProc = null;
    });

    const t0 = Date.now();
    while (Date.now() - t0 < waitMs) {
      if (await probe()) {
        const ms = Date.now() - t0;
        log(`[tts] 服务就绪，用时 ${ms}ms`);
        return { ok: true, started: true, ms };
      }
      if (child.exitCode !== null) {
        throw new Error(`TTS 服务启动失败（code=${child.exitCode}）：${tail.slice(-400)}`);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error(`TTS 服务启动超时（${waitMs}ms）：${tail.slice(-400)}`);
  })().finally(() => { serverStarting = null; });

  return serverStarting;
}

/** 预热：把服务拉起来（第一次合成就不必再等模型加载）。 */
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
 *   splitMethod?: string, timeoutMs?: number, outDir?: string, log?: Function}} [options]
 * @returns {Promise<{path: string, bytes: number, ms: number}>}
 */
async function synthesize(text, options = {}) {
  const clean = String(text ?? '').trim();
  if (!clean) throw new Error('要合成的文本为空');
  const refAudio = options.refAudio || DEFAULT_REF;
  if (!exists(refAudio)) {
    throw new Error(`参考音频不存在：${refAudio}（把干净人声放到 ref/sally_ref.wav）`);
  }
  await ensureServer({ log: options.log });

  const url = new URL(`${BASE}/tts`);
  url.searchParams.set('text', clean);
  url.searchParams.set('text_lang', options.textLang || 'zh');
  url.searchParams.set('ref_audio_path', refAudio);
  url.searchParams.set('prompt_text', options.promptText ?? referenceText());
  url.searchParams.set('prompt_lang', options.promptLang || 'zh');
  url.searchParams.set('text_split_method', options.splitMethod || 'cut5');
  url.searchParams.set('batch_size', '1');
  url.searchParams.set('media_type', 'wav');
  url.searchParams.set('streaming_mode', 'false');

  const t0 = Date.now();
  const res = await fetch(url, { signal: AbortSignal.timeout(Number(options.timeoutMs) || 120000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`TTS HTTP ${res.status}：${body.slice(0, 300)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('TTS 返回空音频');
  const outDir = options.outDir || OUT_DIR;
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
  fs.writeFileSync(out, buf);
  return { path: out, bytes: buf.length, ms: Date.now() - t0 };
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
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => { resolve({ code: -1, stderr: String(e?.message ?? e) }); });
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
  if (!exists(out)) throw new Error(`切片失败：${r.stderr.trim().slice(0, 300)}`);
  const stat = fs.statSync(out);
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
      process.exit(1);
    }
  })();
}
