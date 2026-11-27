# @elysia/ayla-channel

> 状态：规划。Ayla 单独成包，不与 QQ/KOOK/飞书混在一起。
>
> 本文定义目标契约，代码尚未实现。

## 1. 身份

| 项 | 值 |
|---|---|
| 包名 | `@elysia/ayla-channel` |
| 插件 id | `ayla-channel` |
| 目录 | `plugins/ayla-channel/`（规划） |
| 角色 | Event Source + 出站 Sender |
| 管理插件 | `@elysia/context-gate` |
| standalone | 是 |
| manage 开关 | 仅当 Context-Gate 挂载时出现 |

## 2. 为什么单独成包

Ayla 是 WebSocket bridge：

- 有 `v` / `type` 帧协议；
- 有 seq / ack / resume；
- 有媒体 id 签名和短期下载 URL；
- 有 `sent` / `error` 出站结算；
- 和 QQ/KOOK/飞书的产品形态不同。

把 Ayla 和 QQ 等放在一起，会让只想接 QQ 的用户看到无关配置，也会让协议边界混乱。

## 3. 职责

- 连接 Ayla bridge；
- 维护 seq、ack、resume；
- 准入文本和图片附件；
- 把 Ayla 入站帧转成标准 EventEnvelope；
- 提供 Ayla 出站 reply sender；
- standalone 本地订阅/投递；
- managed 注册/publish 到 Context-Gate。

## 4. 事件

```text
ayla.message
```

payload：

```text
conversation_type: private | group
conversation_id
message_id
sender_id / sender_name
text / admitted image references
sent_at
```

旧实现只支持文本和图片；语音、文件、视频、表情、混合消息会被拒绝。新实现若要支持更多类型，需要单独的类型映射和准入，不应把不支持的内容静默截断。

## 5. 两种模式

### standalone

- 本插件保存订阅者；
- 本插件负责待投递队列；
- 只有入站事件成功持久化或投递后，才 ack seq；
- 连接断开后从最后 ack 点 resume。

### managed

- 本插件只注册 kind/publish；
- Context-Gate 负责订阅、队列、注入；
- Context-Gate 持久化成功后才 ack；
- Context-Gate 不可用时，不 ack，等待重试。

### manage 开关

```text
Context-Gate 不存在：standalone，无开关
Context-Gate 存在：开关出现，默认 standalone
开启：managed
```

manager 消失：managed 不可用，不自动降级。

## 6. 状态

```text
ayla-state.json
  lastAckedSeq
  subscription（standalone）
  pendingDeliveries
  connection health / last error
```

凭证不落文档，只存 secret ref 或从 profile 读取。

## 7. 失败与恢复

- 连接断开：保留 seq，指数退避重连；
- 认证失败：不无限重试，进入显式错误状态；
- 媒体下载失败：整条消息不 ack，让 Ayla 重投；
- 附件准入失败：不投递、不截断；
- 出站超时：状态未知，不自动重发；
- 卸载：停止 socket、取消心跳、清理 ack 等待。

## 8. 测试

- 帧解析；
- seq/ack/resume；
- 去重；
- 文本/图片准入；
- 不支持类型拒绝；
- standalone 投递；
- managed publish；
- manager 消失；
- 卸载。

## 9. 相关文档

- [插件文档索引](README.md)
- [Context Gate](context-gate.zh.md)
- [插件开发规范](../architecture/elyh-plugin-spec.zh.md)