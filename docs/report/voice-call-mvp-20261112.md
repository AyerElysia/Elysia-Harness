# 实时通话 MVP 实施记录（2026-11-12）

## 授权与当前状态

用户已批准 `plugins/voice-call/PLAN-MVP.zh.md` 的 MVP 实施。之后明确选择不保存原始音频或整通录音，只保留取得的文字及活动事件，原声不可回放。用户明确授权先使用此前提供的 OpenAI key，并自行在之后替换；这替代审批稿最初“等待另一枚未披露 key”的建议。

凭据已通过现有受控服务保存为 `OPENAI_REALTIME_API_KEY`，再次只读核验返回 `configured: true, source: file`。Web home 的既有忽略文件权限为 `0600 ayerelysia`；真实值未进入源码、文档、命令参数、浏览器或公开日志。下一次通话按操作重新读取，替换入口见 [凭据维护](../operations/voice-call-credentials.md)。

**离线阶段之后已完成 Web 接入并在本机 Chrome 验证通话面板及开始按钮可用；用户尚未开始通话，未创建正式语音 Session、未打开麦克风、未发起付费 Realtime 或实际 TTS 请求。** 端到端通话仍待短测；最新141项检查、受控模型GET200及真实加载证据见 [Web接入记录](2026-11-12-voice-call-web-activation.zh.md)。

本记录不包含密钥、SOUL正文、参考音频转写或原始媒体。

## 最终定向验证

执行地点：Spark 原仓 `Elysia-Harness/plugins/voice-call`。2026-11-12 04:25:53（UTC+8）执行离线阶段整包检查（此前误写12:25，属于重复时区换算，现已更正）：

```sh
../../dsh/node_modules/.bin/vitest run --maxWorkers=1 --no-file-parallelism
../../dsh/node_modules/.bin/tsc -p tsconfig.test.json --noEmit
node build.mjs
```

结果：**11个测试文件、112项通过；源码与测试严格类型检查通过；浏览器 client 构建成功。** 测试使用临时存储和假网络/媒体，不竞争正式存储、服务、端口或 GPU。

| 范围 | 本次结果与证据 |
|---|---|
| 原生 Agent、SOUL-only、真实临时 JSONL、输入notice、全局运维域 | 20项；真正注册/单写者/flush、关闭重开、合法恢复marker、孤立turn/step修复、空正文输入冷读、全局可读审计与幂等碰撞 |
| Realtime 假协议与 Breeze 假 PCM | 37项；精确配置ACK、取消/迟到隔离、out-of-band、真实hangup契约、固定参考参数、PCM格式与奇字节边界 |
| HTTP路由与协议 | 12项；仅owner载体、header capability、无URL凭据、有限body/背压、Request.signal断开清理 |
| 浏览器与插件挂载 | 24项；原生Cordis mount/unmount/remount、默认禁用/无自动拨号、凭据metadata热刷新、fake WebRTC/AudioWorklet、实际consumed回执、SSE闲置超时、结束后重开入口 |
| 通话controller | 19项；幂等start/abort隔离、原始输入事实不因epoch丢失、即时停播、顺序流/32KiB PCM/24k、完整连续段投影、20秒租约、10分钟上限、清理失败不冒充成功 |

这些是本次执行证据，不是未来版本的永久通过承诺。

## 更正与实施取舍

- 最初仅用 `Session.create` 检查的门槛不充分：真实JSONL格式要求首个surface为system head。已更正为先成功装配SOUL并落原生system，再claim实际输入；SOUL失败时原输入保留耐久inbox，不能伪造合法surface。真实JSONL冷读已覆盖。
- 原生JSONL已有 session/event 与 flush 转发；不新增第二写者，不把“有flush listener”误当作真正持久化owner，不使用被禁止的外部 appendPluginRecord。
- 原生API没有合法未结算chunk权威日志，因此完整回复先append+flush，再进入TTS分句流；不是逐token发声，不等待整段WAV。取消前缀保留interrupted原文，不冒充完整发声。
- 只使用全局storageDomain记录基础设施事件，不复制认知正文建立私有账本。无转写时输入为来源明确的空正文notice，不伪造人类原话。
- 早期整包执行从仓库根使用Vitest `--root` 导致jsdom寻找 `/tests/console.spec.ts` 失败；改为在插件cwd执行同一工具后，完整112项通过。没有把0项收集或单测部分通过当成整包成功。
- 默认参考音频、配置、主意识与共享TTS模式未改。Breeze现有已知样例慢于实时，不因流式字节到达就宣称自然通话可用。

## 源码与运维边界

实现位于 `plugins/voice-call`，默认 `enabled:false`。导入/挂载不解析key、不读SOUL/历史、不打开活动存储、不创建Session、不连接模型或媒体；仅注册认证路由/生命周期并读取凭据存在描述。正式拨号需用户显式开始及隐私确认。

稳定设计见 [运行边界](../architecture/voice-call-mvp.md)。无 `dsh/` 修改，无主意识factory替换，无主体文件或参考声音改写，无共享TTS或主程序重启。包依赖复用已有安装，仅在插件自身node_modules增加链接；未执行全仓安装或改动共享锁文件。没有提交、暂存或推送其他任务修改。

## 待完成的真实验收

Web接入和面板验证已完成；后续仍需受控开麦短测。至少核验AudioWorklet/CSP、麦克风权限、实际WebRTC网络、Realtime写接口权限、SOUL更新ACK、字幕、首音及插话延迟、真实hangup和usage、原聊天语音兼容性。模型元数据GET200只证明认证及模型可见，不能替代这些验证。

仍需用户在实际页面点击开始并授权麦克风；本次没有代替用户采集环境声音。上游OpenAI接收并处理音频的政策由其服务约定管理，“本程序不录音”不承诺云端zero retention。

若实际延迟达不到可用体验，保留实验状态并报告；不擅自切模型、OpenAI声音、共享推理模式或默认参考音频。

## 可逆性

本阶段只新增插件代码/测试/构建与文档，以及一个受控凭据引用。插件可独立卸载，卸载不删除原生权威历史。用户可替换或移除同一凭据引用，不需要把新key再贴到聊天。没有删除任何材料，无需恢复旧数据。
