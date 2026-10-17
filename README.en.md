# DSH QQ Voice Chat

Voice I/O and chat-persona bundle for running a **QQ auto-chat agent** on DeepSeek Harness.

- **Voice out** — the agent speaks: local GPT-SoVITS zero-shot cloning, or audio files from its
  voice library. `qq_send_voice` can *only* serve files inside that library.
- **Voice in** — the agent listens: QQ SILK voice notes → 16 kHz wav → SenseVoice (sherpa-onnx),
  falling back to the gateway's own ASR and finally a `[语音]` placeholder.
- **Persona plugins** — `qq-agent-presets` (chat persona + hard tool allowlist) and
  `qq-mode-console` (DSH settings namespace).

## Quick start

```bash
# 1. engines (any location)
export VOICE_TTS_GSV_DIR=/opt/GPT-SoVITS
mkdir -p voice-stt/model
cd voice-stt && npm i sherpa-onnx-node@^1.13.8 silk-wasm@^3.7.1
# put model.int8.onnx + tokens.txt into model/

# 2. wire into your qq-bridge-main (see docs/INTEGRATION.md)
cp packages/voice-out/lib/voice-core.js     <bridge>/src/
cp packages/voice-out/lib/send-voice-lib.js <bridge>/src/

# 3. enable BOTH switches for sending
#    socialV2.voice.enabled = true  AND  socialV2.tools.sendVoice = true

# 4. verify
npm test
```

## What is not included

Models (GPT-SoVITS ~7.5 GB, SenseVoice ~239 MB), `node_modules`, ffmpeg binaries, reference
audio, any `config.json`, tokens, or machine-specific absolute paths. See
[docs/ENV-SETUP.md](docs/ENV-SETUP.md).

## Security boundaries

1. The AI can only send files **inside** the voice library — absolute paths outside it are rejected.
2. Voice rate limits are separate from text rate limits.
3. Success requires `verified=true` (a `get_msg` read-back proving the `record` segment landed).
4. Console filenames are escaped (XSS via uploaded filenames).
5. Voice input never breaks chat: every failure degrades to `[语音]`.
6. `qq-tool-restrict` removes local execution/filesystem tools at registration time.

## Compatibility

Node.js ≥ 18. Defaults target Windows paths; Linux/macOS need the `FFMPEG` / `PY` constants
adjusted. Not end-to-end tested on every platform — see [docs/PROJECT-SUMMARY.md](docs/PROJECT-SUMMARY.md).

## License

MIT. Derived from **qq-bridge-main** (Copyright © 2026 Derpyu520 and qq-bridge / QSH
contributors). See [NOTICE.md](NOTICE.md).
