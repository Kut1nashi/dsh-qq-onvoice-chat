# audio/ —— 语音库（语音输出的音频来源）

AI 的 `qq_send_voice` **只能**从这个目录取文件。这是有意的安全边界：
防止 prompt injection 让 AI 把本机任意文件当语音外发。

- 位置：`qq-bridge-main/audio/`（由 `socialV2.voice.dir` 指定，默认 `audio`）
- 可放子目录，`qq_list_voices` 递归扫描（默认深度 4）
- 支持的扩展名：`.mp3 .wav .ogg .oga .opus .m4a .aac .flac .amr .silk .slk .wma .spx`
- 网关会自动把常见格式转成 QQ 的 SILK，不必自己转
- 上限默认：单条 ≤ 300 秒、≤ 20 MB、每分钟 6 条、每小时 60 条（见 config）

两条来源互不冲突：
1. **手工音频**——把现成语音条丢进来，AI 挑一条发（本目录）；
2. **TTS 合成**——AI 说的文本由 `voice-tts` 实时合成，直接进发送通道，不经过本目录。
