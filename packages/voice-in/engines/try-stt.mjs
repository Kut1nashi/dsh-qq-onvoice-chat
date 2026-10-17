// 本地语音转写：网关取音频 →（QQ SILK / 普通音频）→ 16k 单声道 WAV → sherpa-onnx SenseVoice → 文本
// 用法: node try-stt.mjs <messageId> [audioFile]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sherpa = require('sherpa-onnx-node');
const { decode: silkDecode } = require('silk-wasm');

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const TMP = path.join(HERE, 'tmp');
const FFMPEG = path.join(HERE, 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe');
const MODEL = path.join(HERE, 'model', 'model.int8.onnx');
const TOKENS = path.join(HERE, 'model', 'tokens.txt');
// 桥接 config.json 的位置由环境变量给出（不内置任何本机路径）
const BRIDGE_CFG = String(process.env.QQ_BRIDGE_CONFIG || '').trim();

fs.mkdirSync(TMP, { recursive: true });
const messageId = process.argv[2];
if (!localFile && !messageId) {
  console.error('用法: node try-stt.mjs <messageId> [audioFile]  （或只给 audioFile）');
  process.exit(1);
}
const localFile = process.argv[3] || null;

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => resolve({ code: -1, err: String(e.message) }));
    child.on('close', (code) => resolve({ code, err }));
  });
}

async function getRaw() {
  if (localFile) return fs.readFileSync(localFile);
  if (!BRIDGE_CFG) throw new Error('请设置 QQ_BRIDGE_CONFIG=你的 qq-bridge-main/config.json');
  const cfg = JSON.parse(fs.readFileSync(BRIDGE_CFG, 'utf8'));
  const base = cfg.snowluma.httpUrl.replace(/\/+$/, '');
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${cfg.snowluma.accessToken}` };
  const r = await fetch(`${base}/get_msg`, { method: 'POST', headers, body: JSON.stringify({ message_id: messageId }), signal: AbortSignal.timeout(15000) });
  const msg = await r.json();
  const seg = (msg?.data?.message || []).find((s) => s?.type === 'record');
  if (!seg) throw new Error('NOT_RECORD ' + JSON.stringify(msg).slice(0, 200));
  console.log('record file =', seg.data.file);
  const dl = await fetch(seg.data.url, { signal: AbortSignal.timeout(60000) });
  return Buffer.from(await dl.arrayBuffer());
}

const buf = await getRaw();
console.log('bytes =', buf.length, '| head =', buf.subarray(0, 12).toString('hex'));

const wavPath = path.join(TMP, 'ptt.wav');
let decoded = false;

// ① QQ 语音是 SILK（文件名常骗人地叫 .amr）
const magicAt = buf.indexOf(Buffer.from('#!SILK_V3'));
if (magicAt >= 0) {
  // 注意：QQ 的 SILK 文件带一个 0x02 前缀字节，silk-wasm 必须吃**原始**缓冲区（去掉前缀反而解码失败）
  const silkBuf = buf;
  console.log('SILK detected at offset', magicAt, '（按原始缓冲区解码）');
  const t = Date.now();
  const out = await silkDecode(silkBuf, 24000);
  const pcm = out?.data ?? out;
  console.log('silk decode ms =', Date.now() - t, '| pcm bytes =', pcm.length, '| duration =', out?.duration ?? '?');
  const pcmPath = path.join(TMP, 'ptt.pcm');
  fs.writeFileSync(pcmPath, Buffer.from(pcm));
  const dec = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', pcmPath, '-ar', '16000', '-ac', '1', '-f', 'wav', wavPath]);
  console.log('resample exit =', dec.code, dec.err ? dec.err.trim().slice(0, 200) : '');
  decoded = fs.existsSync(wavPath);
} else {
  const dec = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(TMP, 'ptt.raw'), '-ac', '1', '-ar', '16000', '-f', 'wav', wavPath]);
  console.log('ffmpeg exit =', dec.code, dec.err ? dec.err.trim().slice(0, 200) : '');
  decoded = fs.existsSync(wavPath);
}
if (!decoded) { console.log('DECODE_FAILED'); process.exit(2); }
console.log('wav bytes =', fs.statSync(wavPath).size);

const t0 = Date.now();
const recognizer = new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    senseVoice: { model: MODEL, language: 'zh', useInverseTextNormalization: 1 },
    tokens: TOKENS,
    numThreads: 2,
    provider: 'cpu',
    debug: 0
  }
});
console.log('recognizer ready in', Date.now() - t0, 'ms');

const wave = sherpa.readWave(wavPath);
const stream = recognizer.createStream();
stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples });
const t1 = Date.now();
recognizer.decode(stream);
const out = recognizer.getResult(stream);
console.log('decode ms =', Date.now() - t1);
console.log('TEXT >>>', JSON.stringify(out?.text ?? ''), '| lang =', out?.lang ?? '');
