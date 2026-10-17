// ===== 从 qq-bridge-main/src/bridge.js 第 6056-6121 行抽取（只读参考）=====
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-voice') {
          const body = await readBody();
          const token = String(body.token ?? req.headers['x-agent-token'] ?? '').trim();
          const key = String(body.key ?? body.target ?? '').trim();
          const voice = voiceCfg();
          if (!voice.enabled) { sendJson({ ok: false, error: '语音功能已关闭' }, 403); return; }
          if (!key) { sendJson({ ok: false, error: 'key 不能为空（格式 group:群号 或 private:QQ号）' }, 400); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!token) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2ToolEnabled('sendVoice')) { sendJson({ ok: false, error: '工具未启用：qq_send_voice' }, 403); return; }
          if (blockedByPriming(key)) { sendJson({ ok: false, error: '正在投递交接开场白：这一轮只装上下文，不允许发言' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          // 只要名字（解析）不要内容（预览）：dry-run 也必须经过与真发相同的解析与校验。
          let resolved;
          try {
            resolved = resolveVoicePathForV2(body.voice ?? body.file ?? '');
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
            return;
          }
          try {
            voiceBudgetCheck(key, voice);
            if (body.dryRun === true) {
              const probe = await inspectAudio(resolved.path, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds });
              if (!probe.ok) { sendJson({ ok: false, error: probe.error }, 400); return; }
              sendJson({ ok: true, dryRun: true, key, file: resolved.path, detail: describeAudio(probe) });
              return;
            }
            const sent = await sendVoiceForV2(key, body.voice ?? body.file, {
              label: body.label ? String(body.label).slice(0, 100) : '',
              verify: body.verify,
              readback: body.readback === true,
              // AI 也可以调音量（默认走 config 的 defaultVolume）
              audio: (body.volume !== undefined || body.normalize === true || body.loudness !== undefined)
                ? { volume: body.volume, normalize: body.normalize === true, loudness: body.loudness }
                : null
            });
            sendJson({
              ok: true,
              key,
              messageId: sent.messageId,
              file: path.basename(sent.file),
              detail: sent.detail,
              audioProcessing: sent.audioProcessing,
              // verified=true 表示已用 get_msg 回读到这条消息的 record 段（"真的发出去了"的硬证据）
              verified: sent.verification?.confirmed === true,
              readback: sent.readback,
              warnings: sent.warnings
            });
          } catch (error) {
            // 额度只在真正发出后才记账（voiceBudgetCommit），所以失败路径无需回滚。
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }

