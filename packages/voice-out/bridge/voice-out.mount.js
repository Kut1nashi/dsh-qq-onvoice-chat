// ===== 从 qq-bridge-main/src/bridge.js 第 8200-8208 行抽取（逐字复制）=====
  function sendMessagesV2(key, messages, delays, replyToMessageId, atUserId = null, allowVoice = false) {
    // 自动语音回复的**唯一挂载点**：只有 AI 的工具发送路径会传 allowVoice=true
    // （桥接自己的通知、提示词、错误提示一律不传，永远走文本）。
    // 仅在"单条消息"时考虑语音：多条是刻意的分条节奏，合并成一条语音会破坏它，宁可发文本。
    if (allowVoice && messages.length === 1) {
      return maybeReplyAsVoiceV2(key, messages[0]).then((r) => (
        r?.sent ? [messages[0]] : sendMessagesV2(key, messages, delays, replyToMessageId, atUserId)
      ));
    }
