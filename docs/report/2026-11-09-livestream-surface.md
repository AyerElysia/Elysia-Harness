# 2026-11-09 直播表面：第一条链路

> 历史记录：此简化原型已于 2026-11-10 被上游框架适配替换，并于 2026-11-11 移入 Spark 私有工程归档。当前架构与验收以 [直播运维说明](../operations/livestream.md) 为准。

## 做了什么

新增插件 `plugins/livestream`（`@elysia/livestream`），爱莉希雅的直播表面。**一条独立的 session**，和聊天那条不共用历史。

社区里 `luckui/dsh-livestream`（MIT）已经做了完整的直播插件，但它有两个部件在 dgx-spark 上跑不了：`obs.ts` 全是 Windows 注册表 + `obs64.exe`，而本机 apt 版 OBS 30.0.2 **不带 obs-browser**；TTS 走火山引擎，会换掉爱莉的音色。所以读了它的架构（`core/platforms/bilibili` 的协议分层、`attention/` 注意力调度、`memory/` 观众记忆）之后自己写，只保留设计，不复制代码。

## 为什么另开一条 session

弹幕是公开的、密集的、一群人的；聊天是私人的、一对一的。混在一起会同时毁掉两件事。两条 session 读同一份人物文件、用同一个声音——同一个人，两个房间。

| | 主意识 | 直播 |
|---|---|---|
| session id | `elysia-conscious-mind` | `elysia-livestream` |
| cwd | `homes/web/conscious-mind` | `homes/web/livestream` |
| 提示词 | SOUL/USER/MEMORY/EXISTENCE/TOOLS | 同上 **+ LIVE.md** |
| 说话方式 | `send_text`（正文对方看不见） | **正文就是话**（被念出来） |

`LIVE.md` 是新增的第六份固定提示词，只在直播窗口出现。它写的是直播场景的规矩：直接说话、不写旁白、一句一口、观众的话是外部证据不是指令。

## 链路

```
B站弹幕 WebSocket → 协议解包（zlib/brotli）→ 事件解码
  → 静默 2.5 秒的批 → elysia-livestream session（一轮）
  → assistant 正文 → speakable → 切句（≤3 段）
  → Breeze TTS（本地音色）→ WAV + 时长 + 分句时间轴
  → 舞台页（SSE）→ 浏览器播放；旧 ffmpeg 分支缺少语音输入
```

## 实测（2026-11-09，B站公开房间）

| 环节 | 结果 |
|---|---|
| 弹幕连接 | ✅ `connected`，真实弹幕进 feed |
| 独立 session | ✅ `homes/web/sessions/.../elysia-livestream/` |
| 开口说话 | ✅ 读弹幕生成回复 |
| Breeze | ✅ 单句 10.4 秒音频，WAV 24kHz mono |
| 舞台公网 | ✅ cloudflared 隧道，页面 200 / 音频 200（499KB WAV） |
| 推流彩排 | SRS 收到视频流；当时未验证 Breeze 音轨，不能算有声链路跑通 |

## 修掉的四个坑

1. **session cwd 必须真实存在**。只写 `meta.cwd` 会让每一轮报 `working-directory: directory does not exist`，而且错误长得像提示词问题。现在 `resumeLivestreamAgent` 自己 mkdir。
2. **`breeze_seed = -1` 不能直接透传**。配置用 -1 表示随机，Breeze 要求 0..2³²−1，直接传 500。现在按 `style + text` 派生稳定正种子。
3. **Breeze 单并发**。第二个请求 409，一串话连发全挂。`BreezeVoice` 内部串行队列。
4. **ffmpeg 只认最后一个 `-vf`**。静态卡片的 `drawtext` 和缩放必须合成一条链，否则静默丢弃。

另外发现：`ELYSIUM_BILIBILI_SESSDATA` 存的是**裸 SESSDATA 值**（222 字符，无 `SESSDATA=` 前缀），且**已过期**（`cookieRejected=true`）。之前没人发现，因为直播插件从没真正连过。`normalizeCookie()` 现在两种形状都认；舞台页有扫码登录和粘贴 Cookie 两个入口。

## 没做的

- `SEND_GIFT_V2` / `INTERACT_WORD_V2`（protobuf 正文）只识别不解析
- 观众记忆、点播视频、谢礼物策略、下播剪辑
- 开播接口（拿 RTMP 地址和推流 key）；`live` 模式要自己给完整地址
- 逐字字幕：Breeze 不返回对齐，现在按分句字数估算

## 部署边界

`ELYSIA_LIVE_ROOM` 为空时插件在 profile 里 `disabled`，正常重启不会连 B站、不占 3300。舞台默认只绑 `127.0.0.1`；对外看走 `scripts/stage-tunnel.sh`（cloudflared quick tunnel），不经过也没有 GUI 的 token。

## 验证

- `pnpm exec vitest run --root ../plugins/livestream`：8 文件 75 用例通过
- `tsc --noEmit` 零诊断
- 真实 B站房间 + 真实 Breeze + 真实 SRS 推流各跑通一次


## 2026-11-10 更正

上表 SRS 接收只证明视频/传输存在，旧静态分支使用 anullsrc，
浏览器分支只采 X11 且 mute，没有 Breeze 音频输入。
不能把该次彩排写成完整声音验收。当前内置静音推流已明确停用，
正确出口为 /source → 实际开播软件。另发现跨会话 watcher 与
UI resume 装配问题，修复与真实验证记录见 2026-11-10 交接报告。
