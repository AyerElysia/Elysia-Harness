# 2026-11-09 手动压缩超时诊断

用户截图显示 /compact 返回“Compaction could not produce a useful summary”。
本次仅只读核对源码、会话事件与明确的近期请求归档；没有再次触发压缩、
请求模型、发送平台消息、修改配置或重启服务。只新增本诊断记录。

## 确认的直接原因

commandId 为 cmd-6c3eabe7-1，compactionId 为
ad4b96c2-fc5a-41dd-b7ac-6a105c874982。主会话
elysia-conscious-mind 的 v4 原日志记录：

- seq13568 command/run：compact
- seq13569 compaction/start：2026-11-09T17:39:25.338+08:00
- seq13570 compaction/end：2026-11-09T17:39:36.014+08:00，error = Request timed out.
- seq13571 command/done：kind = error

压缩尝试持续10.676秒。截图文字是 command-compact/src/index.ts 的 summary
通用错误分支。compaction-basic/src/region.ts 将摘要准备阶段的非
SurfaceChangedError 统一映射到该分支，原始错误提前保存在end事件中。
因此该文字不证明生成过“无用”摘要，也不是摘要太长的证据。

对应归档为 2026-11-09T09-39-25-343Z-cf7707e2.json：
provider=d1api，model=deepseek-v4.1-flash，purpose=compaction，
maxTokens=65536，3495条messages、9个tools、2条toolHistory，
格式化JSON为3,365,331字节。归档证明适配器前输入，不证明网络已送达。
未读取或输出主体提示词正文、聊天正文或凭据。

## 超时层级及限制

compaction-basic 本身没有10秒时间预算；手动命令合并agent与command的取消信号。
maxTokens是生成token上限。d1api的实际api为openai-completions，
streamIdleTimeoutMs=300000，未配置profile.timeoutMs。
DSH llm-pi-ai adapter仅在profile提供timeoutMs时向SDK传递它，并设置maxRetries=0。
其流空闲超时报错另有明确的pi-ai stream idle timeout文案，与本次不同。

已装OpenAI 7.19.0 SDK的APIConnectionTimeoutError默认文案正是
Request timed out.；SDK默认总请求超时600000ms。
SDK也会把底层ConnectTimeoutError转换成相同文本，已装Undici默认连接超时为10秒。
10.676秒与建连超时相容，但pi-ai错误封装没有保留底层cause，
目前不能把这项推断当作已确证的具体TCP/DNS/TLS根因。
本次未设置自定义代理/timeout环境的最新进程只能作为当前环境证据，
不能反推已退出进程在故障当时的所有传输状态。

截图前普通请求的持久重试元数据（不含正文）：
[
  {
    "seq": 13560,
    "time": 1794216951335,
    "provider": "d1api",
    "retry": 1,
    "maxRetries": 5,
    "timeoutMessagePresent": true
  },
  {
    "seq": 13563,
    "time": 1794216962507,
    "provider": "d1api",
    "retry": 2,
    "maxRetries": 5,
    "timeoutMessagePresent": true
  }
]

若timeoutMessagePresent为true，它证明普通对话也遇到相同超时；
不能仅根据相邻归档时间推断调用成功或失败。
本次compaction start/end之间只见一次对应归档，没有成功摘要。

## 数据是否丢失

start与end序号连续，中间没有compaction/summary或surface replacement。
源码只有await summarize与稳定性检查成功后才进入commitCompactionBody，
先写compaction/summary，再追加带replace的user/message。
此次失败仅留下尝试和错误记录，没有提交摘要、替换旧可见上下文或释放其预算。
原始历史仍在；本结论不是对既往所有压缩或整体语义健康的裁决。

## 运维边界

诊断开始时Web为1394346/1394325，17:33:30+08启动，owner ayerelysia。
调查期间该进程被任务外替换，新1487763/1487742于17:46:37+08启动，
cwd仍为Elysia-Harness/dsh，127.0.0.1:3299监听正常。
本次与子代理没有发送signal、启动命令或安装恢复机制；
不能把这次后来的替换解释成本次17:39摘要失败的已知原因。

下一步若要修复，应保留可脱敏的底层连接cause、核对D1通道的连接稳定性，
并单独设计摘要调用的取消与有界重试；不应把超时误判成摘要质量或
盲目提高maxTokens。当前任务未修改任何压缩/主体连续性机制。
