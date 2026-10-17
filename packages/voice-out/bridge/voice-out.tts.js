// ===== 从 qq-bridge-main/src/bridge.js 第 8281-8358 行抽取（只读参考，接进你自己的 bridge.js）=====
  function ttsCore() {
    if (ttsCoreLoaded) return ttsCoreModule;
    ttsCoreLoaded = true;
    try {
      const mod = String(voiceCfg().tts?.module ?? '').trim();
      if (!mod) return null;
      if (!ttsCoreRequire) ttsCoreRequire = createRequire(import.meta.url);
      ttsCoreModule = ttsCoreRequire(mod);
    } catch (error) {
      log(`[tts] 加载 TTS 模块失败：${error?.message ?? error}`);
      ttsCoreModule = null;
    }
    return ttsCoreModule;
  }

  /** 最近一条**对方**消息是不是语音条。 */
  function lastIncomingWasVoice(key) {
    try {
      const list = getSocialV2State(key)?.recentMessages;
      if (!Array.isArray(list)) return false;
      for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i];
        if (!m || m.isSelf) continue;
        const text = String(m.text ?? m.plain ?? '');
        return /\[语音/u.test(text);
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * 尝试把这条回复用语音发出去。
   * @returns {Promise<{sent: boolean, via?: string, reason?: string}>} sent=false 时调用方照常发文本。
   */
  async function maybeReplyAsVoiceV2(key, text) {
    const vc = voiceCfg();
    const tts = vc.tts ?? {};
    if (vc.enabled === false || tts.enabled === false) return { sent: false, reason: 'disabled' };
    if (shouldBlockSilentReply(key)) return { sent: false, reason: 'silent' };
    const clean = String(text ?? '').trim();
    if (!clean) return { sent: false, reason: 'empty' };
    if (clean.length > (Number(tts.maxChars) || 200)) return { sent: false, reason: 'too-long' };
    const answeringVoice = lastIncomingWasVoice(key);
    const probability = Number(tts.replyProbability ?? 0.05);
    if (!answeringVoice && !(Math.random() < probability)) return { sent: false, reason: 'probability' };
    try {
      // 先查额度，避免白白合成一次（额度在真正发出去之后才记账）。
      voiceBudgetCheck(key, vc);
    } catch {
      return { sent: false, reason: 'rate-limit' };
    }
    let out;
    try {
      const mod = ttsCore();
      if (!mod || typeof mod.synthesize !== 'function' || typeof mod.available !== 'function' || !mod.available()) {
        return { sent: false, reason: 'tts-unavailable' };
      }
      out = await mod.synthesize(clean, {
        textLang: tts.textLang || 'zh',
        promptLang: tts.promptLang || 'zh',
        timeoutMs: Number(tts.timeoutMs) || 120000,
        startTimeoutMs: Number(tts.startTimeoutMs) || 180000,
        queueTimeoutMs: Number(tts.queueTimeoutMs) || 15000,
        maxBytes: vc.maxBytes,
        log: (m) => log(String(m))
      });
      // 合成期间可能已切换静默模式，或其它消息用掉了额度。
      if (shouldBlockSilentReply(key)) return { sent: false, reason: 'silent' };
      const current = voiceCfg();
      if (current.enabled === false || current.tts?.enabled === false) return { sent: false, reason: 'disabled' };
      voiceBudgetCheck(key, current);
      const resolved = resolveVoicePathForOperator(out.path);
      await sendVoiceV2(key, resolved.path, { guard: true, audit: true });
      voiceBudgetCommit(key);
      const why = answeringVoice ? '回应语音消息 → 100%' : `随机命中 ${Math.round(probability * 100)}%`;
      log(`[tts] 已发语音回复 (${key})：${why}，${path.basename(out.path)} ${out.bytes}B`);
      appendActivity(`${key} [tts] 语音回复（${why}）`);
      return { sent: true, via: answeringVoice ? 'voice-message' : 'probability' };
    } catch (error) {
      log(`[tts] 语音回复失败，退回文本 (${key})：${error?.message ?? error}`);
      return { sent: false, reason: 'error' };
    } finally {
      // synthesize 产物归本次调用所有；发送完成或失败后都释放。
      if (out?.path) cleanupTemp(out.path, true);
    }
  }
