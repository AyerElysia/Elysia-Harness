# 旧实现迁移映射

> 状态：2026-11-26。`plugins/_archive-elysia-v1/` 中的旧实现已不参与当前 profile 挂载。
> 本文把旧包拆成当前扩展架构中的 Tool / Event / Service / UI 角色，避免再次把旧包当作“主意识插件”或“潜意识插件”。

## 1. 迁移原则

旧包是**产品级单体插件**。新架构不允许再按“意识”拆包，而是按扩展点拆：

```text
Tool Provider       模型可调用能力
Event Adapter       入站事件 / 生命周期事件 / 上下文
Service             发送器、TTS、ASR、SQLite、索引
Policy              工具面、权限、确认、压缩策略
UI                  面板、页面、侧栏
Orchestration       工具面、Context Bus、预设组合
```

同一个旧包可以被拆到多个新包，一个旧模块也可以只保留为 Service。

## 2. 旧包清单

### `@elysia/ayla-app`

- **Event Source**：Ayla WebSocket 入站、图片附件、会话身份
- **Service**：Ayla sender
- **当前状态**：归档，未挂载

### `@elysia/feishu-app`

- **Event Source**：飞书事件长连接、入站文本
- **Service**：飞书 sender
- **当前状态**：归档，未挂载

### `@elysia/kook-bot`

- **Event Source**：KOOK Gateway、入站图文
- **Service**：KOOK REST sender、语音发送
- **当前状态**：归档，未挂载

### `@elysia/qq-napcat`

- **Event Source**：QQ / NapCat OneBot 入站
- **Service**：QQ 文本 / 链接 sender
- **当前状态**：归档，未挂载

### `@elysia/conscious-mind`

拆分结果：

| 旧模块 | 新角色 |
|---|---|
| `send-text` / `outbound` | `send_text` Tool Provider + Channel Sender Service |
| `send-voice` / `breeze-tts` | `send_voice` Tool Provider + TTS Service |
| `pending` / `inbound` | 渠道 Event Adapter / 待处理队列 |
| `standing-prompts` | Context Provider |
| `current-time` | Context Provider；DSH 原生时间上下文可替代 |
| `file-capabilities` / `web-capabilities` | 原生工具或扩展 Tool Provider |
| `skill-capabilities` | 原生 Skill 工具适配 |
| `external-reply-guard` / `local-send-confirmation` | Policy / Gate |
| `pass` | Turn 控制工具 |
| `main-session` / `turn` / reply | Agent turn 编排，不再是独立插件类型 |

**当前状态**：整体归档。不要把整包重新挂成一个“主意识插件”。

### `@elysia/subconscious`

拆分结果：

| 旧模块 | 新角色 |
|---|---|
| `session/event` 监听、Observation / Batch | Event Consumer / Context Consumer |
| `router-session` / `memory-session` | Agent Session 编排，可选目标能力 |
| `dispatch-tools` / `subconscious_report` | Tool Provider |
| `store` / `dispatch-store` | Service / SQLite |
| `schedule-guard` | Policy / 事件调度 |
| `router` 心跳与任务预算 | Service / Orchestration |

**当前状态**：归档。感知/记忆能力未在当前 profile 启用。

### `@elysia/session-communication`

- **Tool Provider**：`session_list`、`session_send`、`session_read`
- **Event**：内部消息投递、回复关联
- **Service**：通讯 SQLite、附件转交、历史查询
- **当前状态**：归档，未挂载

### `@elysia/session-compaction`

- **Policy / Service**：给 Session 补齐原生 compaction 与 `/compact`
- **当前状态**：归档；当前由 profile/DSH 组合负责，不需要独立扩展插件

### `@elysia/request-archive`

- **Event Hook**：`llm/stream` 前归档请求
- **Service**：请求保留、索引、淘汰
- **当前状态**：归档，未挂载

### `@elysia/context-inspector`

- **UI / 只读服务**：展示最新归档请求、token 指标
- **依赖**：`request-archive`
- **当前状态**：归档，未挂载

### `@elysia/dsh-livestream`

- **Event Source**：B 站登录、房间、弹幕、礼物、直播状态
- **Service**：B 站协议、ASR、Breeze TTS、OBS、播放器
- **UI**：直播控制台、舞台、观众视图
- **当前状态**：归档，未挂载

### `@elysia/voice-call`

- **Event / Service**：实时语音、PCM、VAD、Gemini/OpenAI realtime
- **UI**：通话面板
- **当前状态**：归档，未挂载

### `@elysia/gemini-cascade`

- **Service / Bridge**：Gemini 音频回合、桌面 host、原生 turn 桥
- **UI**：cascade 界面
- **当前状态**：归档，未挂载

### `@elysia/memory`

- **占位**：没有运行时能力、工具、session 或文件读写
- **当前状态**：归档；不进入当前架构

### `@elysia/proactive-system`

- **Tool Adapter**：`schedule_create/list/view/edit`
- **Context**：计划使用说明与案例
- **Service / Host**：原生 Schedule Host 接入
- **当前状态**：归档；当前由 DSH 原生 schedule + profile 组合处理

## 3. 当前不迁移的东西

以下旧模块不进入新扩展层：

- 以“主意识 / 潜意识 / 记忆 Session”作为插件边界的整体设计；
- `capability-core` / `capability-panel` 的共享 Host core；
- 旧 `capability-host` 的全局注入开关；
- 旧插件的独立 session 创建权；
- 旧请求归档 / 上下文查看器的 Host 强耦合。

## 4. 迁移后的目标包形状

```text
plugins/
  channel-<name>/          Event Source + Channel Sender
  session-communication/   session_* Tools + Store Service
  voice-<name>/            Voice Event + TTS/ASR Service
  live-<name>/             Live Event + Media Service
  memory-<name>/           Observation Consumer + Memory Tools
  request-archive/         llm/stream Hook + Store
  context-inspector/       Read-only UI
```

具体包名在实现时确定；不要把上面的占位目录直接提交为空包。

## 5. 验收

旧包迁移到新架构时，必须逐项确认：

- 是否有独立的 Tool Provider；
- 是否有独立的 Event Adapter；
- 是否只使用 Service 而不创建私有 Session；
- 是否有明确的工具面 / Gate 归属；
- 是否能在不加载 Helix 时运行；
- 是否能在卸载后清理监听器、工具、定时器和存储句柄。