# 直播工具

固定会话 `elysia-livestream` 的公开口播只通过 `live_say`。开场、回应观众和道别都由爱莉选择何时调用。普通 assistant 正文保留在 DSH 会话中。

## `live_say`

开启直播回应后可调用。

| 参数 | 用法 |
| --- | --- |
| `text` | 必填。写这次要说的话，支持下列 Breeze 原生声音标记。 |
| `reply_to` | 可选。填写 1 至 8 个互不重复的本场直播事件 `ref`，用于把口播关联到对应观众输入。开场、道别或没有特定回应对象时可省略。 |
| `stage_mood` | 可选。填写当前角色包支持的表情名，省略时使用 `talk` 表情。 |
| `expression_instruction` | 可选，最多 1000 字符。描述本句的语气、语速或情绪，例如「放慢一点，带着笑意说」。合成沿用配置好的 Breeze 参考音色。 |

`reply_to` 使用直播输入中附带的事件引用。需要补读事件内容时，可把同一个引用交给 `read_livestream_event`。这是原生直播会话中的回应关联。

在 `text` 的对应位置插入 `[笑]`、`[叹气]`、`[咳嗽]` 或 `[清嗓子]`，Breeze 会处理这些声音标记，字幕显示时会去掉它们。

```json
{
  "text": "[笑] 晚上好，欢迎进来坐坐。",
  "expression_instruction": "语气轻松，第一句稍慢。"
}
```

回应指定弹幕时，把输入里附带的 `ref` 原样填进数组。下面用占位符示意。

```json
{
  "text": "你问今天播什么呀？先和大家聊一会儿。",
  "reply_to": ["<本场弹幕的 ref>"],
  "stage_mood": "talk"
}
```

工具返回 `id` 和 `state`，有诊断时附带 `detail`。

| `state` | 含义 |
| --- | --- |
| `ended` | 目标播放页已回报实际播完。 |
| `failed` | 合成、交付或播放失败。 |
| `cancelled` | 本句因取消而结束。 |
| `timeout` | 语音链路达到时限，未确认播放完成。 |

## 本场默认工具

- 口播与结束本轮为 `live_say`、`pass`。`pass` 记录理由并结束当前轮。
- 本场事件和舞台信息为 `read_livestream_event`、`look`、`show_stats`。
- 公开资料与内容为 `view_profile`、`read_comments`、`my_fans`、`search_videos`。
- 视频操作为 `watch_video`、`play_video`、`stop_video`。

默认列表已移除 `check_inbox` 与 `read_dm`。平台写入动作默认关闭，由部署的 `allowedWriteActions` 显式开放。
