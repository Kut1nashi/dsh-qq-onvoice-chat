// ===== 从 qq-bridge-main/src/bridge.js 第 1399-1530 行抽取（只读参考，接进你自己的 bridge.js）=====
/**
 * 语音段 → 文本；返回 null 表示「拿不到转写」，由调用方退回 [语音] 占位。
 * @param data      record 段的数据（可能自带 text）
 * @param messageId 该消息（或引用消息）的 message_id；段里自带 text 时用不到
 */
// ── 本地语音转写（SILK → SenseVoice） ────────────────────────────────────────
// 为什么要有这条兜底：QQ 侧 ASR（fetch_ptt_text）实测会失败或直接挂死
// （2026-10-12 实测 retcode=100「ptt translate failed: error=9」，重试则请求超时），
// 它一失败整条语音在 AI 眼里只剩 [语音] 占位 —— 等于「听不见」。
// 依赖与模型放在仓库之外（voice-stt 目录），只在真正用到时 require，不影响桥接启动。
// 默认模块路径不写死：由 config.json 的 socialV2.voice.localStt.module 指定，
// 也可用环境变量 VOICE_STT_MODULE 兜底。两者都空 = 本机没装 STT 引擎。
const LOCAL_STT_DEFAULT_MODULE = String(process.env.VOICE_STT_MODULE || '').trim();
// bridge.js 是 ESM（package.json type=module），模块作用域没有 require；
// 本地转写模块是 CJS，用 createRequire 按绝对路径加载。
// 注意：**懒建**——不在模块顶层调 createRequire(import.meta.url)，否则任何把 bridge.js
// 拿去当脚本求值的工具（scripts/audit-bridge-harness.mjs 就是）都会在初始化时炸掉。
let localSttRequire = null;
let localSttModule = null;
let localSttLoaded = false;

function getLocalSttRequire() {
  if (!localSttRequire) localSttRequire = createRequire(import.meta.url);
  return localSttRequire;
}

function localSttConfig() {
  // 注意：模块作用域里没有 cfg —— cfg 是 loadConfig() 内的局部变量，这里必须自己再取一次。
  const v = loadConfig().socialV2?.voice?.localStt ?? {};
  return {
    enabled: v.enabled !== false,
    module: v.module || LOCAL_STT_DEFAULT_MODULE,
    maxBytes: Number(v.maxBytes) || 20 * 1024 * 1024,
    downloadTimeoutMs: Number(v.downloadTimeoutMs) || 60000,
    backfill: v.backfill !== false,
    backfillMax: Number(v.backfillMax) || 10
  };
}

function getLocalStt() {
  if (localSttLoaded) return localSttModule;
  localSttLoaded = true;
  const conf = localSttConfig();
  if (!conf.module) {
    log('[local-stt] 未配置 localStt.module，跳过本地转写');
    return null;
  }
  try {
    localSttModule = getLocalSttRequire()(conf.module);
    log(`[local-stt] 本地语音转写已加载：${conf.module}`);
  } catch (error) {
    localSttModule = null;
    log(`[local-stt] 本地语音转写加载失败（收到的语音将退回 [语音]）：${error?.message ?? error}`);
  }
  return localSttModule;
}

/** 取语音条音频：优先段里的 url / 本地 path，其次向网关要一次下载地址。 */
async function fetchRecordAudio(data, { downloadTimeoutMs = 60000 } = {}) {
  let url = typeof data?.url === 'string' ? data.url.trim() : '';
  const localPath = typeof data?.path === 'string' ? data.path.trim() : '';
  if (!url && localPath) {
    try {
      if (fs.existsSync(localPath)) return { buffer: fs.readFileSync(localPath), via: 'path' };
    } catch {}
  }
  if (!url && data?.file) {
    const { ok, body } = await snowlumaHttpAction('get_record', { file: String(data.file) }, 15000);
    if (ok && typeof body?.data?.file === 'string') url = body.data.file.trim();
  }
  if (!url) throw new Error('拿不到语音下载地址（段里既无 url 也无 file）');
  const res = await fetch(url, { signal: AbortSignal.timeout(downloadTimeoutMs) });
  if (!res.ok) throw new Error(`下载语音失败 http=${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new Error('下载到的语音是空文件');
  return { buffer, via: 'url' };
}

/** record 段 → 本地转写文本；失败返回 null，由调用方退回 [语音] 占位。 */
async function transcribeRecordLocally(data, messageId) {
  const conf = localSttConfig();
  if (!conf.enabled) return null;
  const stt = getLocalStt();
  if (!stt) return null;
  const tag = messageId || '(无 id)';
  const { buffer, via } = await fetchRecordAudio(data, { downloadTimeoutMs: conf.downloadTimeoutMs });
  if (buffer.length > conf.maxBytes) {
    log(`[local-stt] 语音条 ${tag} 超过体积上限（${buffer.length} 字节），跳过本地转写`);
    return null;
  }
  const out = await stt.transcribeBuffer(buffer);
  const text = String(out?.text ?? '').trim();
  if (!text) {
    log(`[local-stt] 语音条 ${tag} 本地转写为空（取音频 ${via}，${out?.ms ?? '?'}ms）`);
    return null;
  }
  log(`[local-stt] 语音条 ${tag} 本地转写成功（${out?.ms ?? '?'}ms，取音频 ${via}）：${text.slice(0, 60)}${text.length > 60 ? '…' : ''}`);
  return text;
}

async function resolveRecordText(data, messageId) {
  const inline = typeof data?.text === 'string' ? data.text.trim() : '';
  if (inline) return inline;
  const id = messageId == null ? '' : String(messageId).trim();
  if (id) {
    const hit = pttTextCache.get(id);
    if (hit) {
      const ttl = hit.text ? PTT_TEXT_OK_TTL_MS : PTT_TEXT_MISS_TTL_MS;
      if (Date.now() - hit.ts < ttl) return hit.text || null;
    }
  }
  let text = null;
  // ① 本地 SenseVoice 优先：QQ 侧 ASR 会失败或挂死（最长拖 8 秒），本地 0.5 秒级出结果且不花钱。
  try {
    text = await transcribeRecordLocally(data, id);
  } catch (error) {
    log(`[local-stt] 语音条 ${id || '(无 id)'} 本地转写失败，改用 QQ 侧 ASR：${error?.message ?? error}`);
  }
  // ② 本地不可用时再问 QQ 侧 ASR（需要 message_id）。
  if (!text && id) {
    try {
      const { ok, status, body } = await snowlumaHttpAction('fetch_ptt_text', { message_id: id });
      if (ok && body?.status === 'ok' && body?.retcode === 0) {
        text = String(body?.data?.text ?? '').trim() || null;
        if (!text) log(`[voice] 语音条 ${id}：QQ 转写返回空，按无转写处理`);
      } else {
        const detail = body?.message ?? body?.wording ?? '';
        log(`[voice] 语音条 ${id}：无 QQ 转写（http=${status} retcode=${body?.retcode ?? '?'}${detail ? ` ${detail}` : ''}）`);
      }
    } catch (error) {
      log(`[voice] 语音条 ${id}：转写请求失败，按无转写处理（${error?.message ?? error}）`);
    }
  }
  if (id) rememberPttText(id, text);
  if (text) log(`[voice] 语音条 ${id || '(无 id)'} 转写成功：${text.slice(0, 60)}${text.length > 60 ? '…' : ''}`);
  return text;
}
