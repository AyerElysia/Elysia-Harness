# @elysia/channel-im

> 状态：规划。QQ / KOOK / 飞书共用一个通道插件；Ayla 单独成包。
>
> 本文定义目标契约，代码尚未实现。不要把本页的工具、事件或状态当作当前运行能力。

## 1. 身份

| 项 | 值 |
|---|---|
| 包名 | `@elysia/channel-im` |
| 插件 id | `channel-im` |
| 目录 | `plugins/channel-im/`（规划） |
| 平台 | QQ / KOOK / 飞书 |
| 角色 | Event Source + 出站 Sender |
| 管理插件 | `@elysia/context-gate` |
| standalone | 是 |
| manage 开关 | 仅当 Context-Gate 挂载时出现 |

## 2. 为什么合并

QQ、KOOK、飞书都是“外部人类消息 → Agent”的同类通道：

- 有自己的凭证和协议；
- 有自己的入站消息解析；
- 有自己的出站发送；
- 不参与 Session 创建、上下文注入和 turn 决策。

Ayla 使用另一套 bridge 协议和 ack/resume 语义，单独成包，避免想让 QQ 入站的用户被 Ayla 配置吓到。

## 3. 职责

- 读取各平台配置和凭证；
- 连接/订阅平台事件；
- 解析文字、图片、附件和平台允许的系统事件；
- 做平台侧去重和 ack；
- 把入站内容转成标准 EventEnvelope；
- 提供出站 sender（`send_text` / 渠道 API）；
- 在 standalone 模式下维护自己的订阅编辑器和投递；
- 在 managed 模式下只注册事件和 publish。

## 4. 非职责

- 不创建 Session；
- 不决定模型如何回复；
- 不写系统提示词；
- 不拥有 Context Gate 的队列；
- 不管理其他插件；
- 不把平台私有对象直接塞进模型上下文。

## 5. 当前旧实现覆盖

旧仓库已存在：

- QQ 私聊文字；
- QQ 群聊文字；
- KOOK 私聊/频道文字；
- KOOK 私聊/频道图片；
- KOOK KMarkdown；
- 飞书私聊/群聊文字。

旧实现没有统一处理 @、回复、文件、撤回、编辑、群成员变化等；这些是目标能力，不应写成已完成。

## 6. 事件

建议 kind：

```text
channel.qq.message
channel.kook.message
channel.feishu.message
```

事件 envelope：

```text
kind
source:
  channel
  account / instance
  conversation
  sender
payload:
  platform message id
  text
  attachments
  reply / mention metadata（若平台支持）
visibility
dedupeKey
occurredAt
```

“能不能收到某条消息”由本插件决定；Context-Gate 不做通用 source 过滤。
订阅者只要订阅了对应 kind，就收到本插件已经允许发布的消息。

## 7. 两种模式

### standalone

```text
本插件保存订阅者 / 本地投递
不注册 Context-Gate
不写 Context-Gate 队列
```

入站 ack 只在本地持久化或投递成功后确认。

### managed

```text
本插件只 register kind + publish
订阅、队列、合并、注入由 Context-Gate 负责
ack 只在 Context-Gate 持久化成功后确认
```

### manage 开关

```text
Context-Gate 不存在
  → standalone 强制
  → 不显示开关

Context-Gate 存在
  → 显示 manage 开关（默认关 = standalone）
  → 打开后 managed
```

manager 消失时 managed 进入 unavailable；不自动切 standalone。

## 8. 状态

```text
channel-im-state.json
  accounts
  subscriptions（仅 standalone）
  cursors
  pendingAcks
```

凭证不写进状态文件；只存 secret ref 或从 profile 读取。

## 9. 失败与恢复

- 平台断开：保留 cursor，重连后从 ack 点恢复；
- 准入失败：不 ack，平台重投，或记录不可投递原因；
- managed 模式下 Context-Gate 不可用：不假装成功；
- 发送失败与状态未知分开处理；
- 卸载：关闭连接、取消监听、清理 pending ack 和 timer。

## 10. 测试

- QQ / KOOK / 飞书解析 fixture；
- 图片/附件准入；
- 重复投递去重；
- ack 时机；
- standalone 投递；
- managed publish；
- 无 manager 时开关不出现；
- manager 消失时的错误状态；
- 卸载清理。

## 11. 相关文档

- [插件文档索引](README.md)
- [Context Gate](context-gate.zh.md)
- [插件开发规范](../architecture/elyh-plugin-spec.zh.md)