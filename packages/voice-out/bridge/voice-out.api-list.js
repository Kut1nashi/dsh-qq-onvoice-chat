// ===== 从 qq-bridge-main/src/bridge.js 第 6281-6325 行抽取（只读参考）=====
        if (req.method === 'GET' && (url.pathname === '/api/socialV2/voices' || url.pathname === '/api/voice/list')) {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const voice = voiceCfg();
          const agentCall = Boolean(req.headers['x-agent-token']);
          // 与发送接口同样的分层：voice.enabled 只关 AI 通道；操作者（控制台面板）仍可列语音库。
          if (agentCall && !voice.enabled) { sendJson({ ok: false, error: '语音功能已关闭' }, 403); return; }
          if (agentCall && !key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (agentCall && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (agentCall && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (agentCall && !v2ToolEnabled('sendVoice')) { sendJson({ ok: false, error: '工具未启用：qq_send_voice' }, 403); return; }
          const wantProbe = url.searchParams.get('probe') !== '0';
          try {
            const files = listAudioFiles(voice.dir);
            const items = [];
            for (const f of files.slice(0, 100)) {
              const entry = { name: path.relative(voice.dir, f).split(path.sep).join('/') };
              if (wantProbe) {
                const info = await inspectAudio(f, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds });
                entry.ok = info.ok;
                entry.bytes = info.size;
                entry.detail = info.ok ? describeAudio(info) : null;
                entry.seconds = info.duration ?? null;
                if (!info.ok) entry.error = info.error;
              }
              items.push(entry);
            }
            sendJson({
              ok: true,
              key: key || null,
              dir: agentCall ? undefined : voice.dir,
              count: items.length,
              voices: items,
              limits: { maxSeconds: voice.maxSeconds, maxBytes: voice.maxBytes, maxPerMinute: voice.maxPerMinute, maxPerHour: voice.maxPerHour },
              // ⚠️ 提示语里也不能出现绝对路径：AI 通道下同样要脱敏（dir 字段已经抑制了，
              // 但这里的模板字符串曾无条件插值 voice.dir —— 等于从旁边的字段又漏出去一次）。
              hint: items.length
                ? '用 qq_send_voice 传 name 即可把其中一个当语音发出去'
                : (agentCall ? '语音库为空：请让管理员先把音频放进语音库' : `语音库为空：把音频文件放进 ${voice.dir} 后重试`)
            });
          } catch (error) {
            sendJson({ ok: false, error: `读取语音库失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
