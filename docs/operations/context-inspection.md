# ElyHarn 上下文查看

适用于 DSH 的 elysia-conscious-mind 主会话。旧 Python Elysium 的 QQ 请求是另一条运行链，
不能在本 DSH 会话轨迹中查到。

## 会话内的上下文查看器

Web profile 挂载独立的 @elysia/context-inspector 插件。打开目标会话后，
切换顶部“上下文”，默认读取该会话最近归档的实际框架请求，并显示采集时间、
provider、模型、消息数、工具数、request ID 和是否为代理循环调用。

四个视图为“系统提示词”“完整消息”“工具定义”“原始 JSON”。
系统视图包含独立 system 字段和所有 system/developer 消息；动态注入不会只因其角色
为 developer 被排除。系统结构完整加载后可切换可读文本和 JSON 结构。
完整消息保留原顺序、角色、工具调用、结果及附件引用；工具视图展示当次实际定义，
原始 JSON 保留生成参数和归档外层身份。

默认只读取当前视图的一段。页面明确显示已加载/总字节和“尚未完整”，
可“继续加载”或“加载全文”；取消、切换会话、切换视图和刷新会停止旧读取。
一个视图的分页固定到同一 request ID，新的模型调用不会混进已打开的旧快照。
点击“刷新”后重新选择最近请求。本功能没有下一轮预览，也不会触发模型调用。

这是一份 llm/stream 适配器前的输入归档：不等同于服务商最终收到的 HTTP 请求，
不证明调用成功；图片保留附件引用，不内嵌附件原始字节。
查看器不会修改提示词、会话历史、主体文件或原归档。

### 权限、索引与资源

接口走 DSH 原生 Gateway/Remote 的登录、Origin 和 session 资源授权，
新增 contextInspector/latest 与 contextInspector/read 动作不会自动授予已有只读分享角色。
每次读取还校验归档中的 sessionId，不能用另一个会话的 request ID 跨会话读取。
归档文件名、文件类型、路径边界、字节偏移与 UTF-8 边界均在服务端校验。

request-archive 在原 JSON 原子发布后更新每会话最新指针，指针只是可重建派生索引；
指针写入失败可观测，但不把已经成功归档的模型调用变成失败。
首次接入旧归档时由运维指定已知文件建立指针，接口不会扫描数 GB 历史来寻找正文。
缺少指针会明确显示索引未就绪，不能把错误冒充为“没有提示词”。
后端使用有界 worker 解析与缓存，按块返回；超出资源上限会明确失败，不静默截断。

## 输入框下方的上下文用量

@elysia/context-inspector 通过原生 conversation.composer.dock 插槽提供“当前估算”。
当前保留 surface 的系统、工具、消息使用同一计数器，总量严格等于三项相加。
重写或压缩替换会立即移除旧节点价格，不从旧请求实报加减历史残差。
主会话不会为了更新仪表而调用模型或发平台消息。

默认对配置的 deepseek-v4.1-flash / deepseek-flash / deepseek-v4-flash 路由，
使用 DeepSeek 官方公开 V4.1 Flash tokenizer 的本地参考分词。
未匹配的模型走明确标记的加权字符估算；超出单段本地分词预算时，
整段使用加权估算并标记混合计数，不静默裁剪文本。
消息/工具协议封装仍是估算，第三方渠道的模型别名也不能证明其内部 tokenizer 相同。
因此界面始终使用“估算”和 ~，服务商实报才是该次请求的用量依据。
保留图片、文件或未知扩展内容时明确显示“部分”，不显示完整占用百分比。

“最近 API 实报输入”来自持久事件中的正数 usage，输入总量 =
DSH 的未缓存输入 + 缓存读取 + 缓存写入；输出和 reasoning 不额外加到输入。
DSH 的 inputTokens 语义是未缓存输入，不能直接当成服务商 prompt_tokens 总量。
SDK 超时产生的全零默认 usage 不会覆盖之前的正数实报。
实报显示原始 ISO 时间、provider、model 和普通对话/压缩调用来源，
并标明当前内容或路由是否已变化；压缩调用的专用输入不冒充当前普通对话。
服务商没有报告用量时明确显示缺失，不构造“准确”的三分类分摊。

本插件新增独立 elysiaContextMetrics 派生投影，不修改 DSH、旧原生投影、
压缩触发逻辑或会话正文。检查点仅存数字、哈希与路由/usage 元数据；
计数配置或资源指纹变化会使旧检查点失效并重放。
计数器与有界缓存随插件卸载释放。metrics.enabled=false 可关闭本仪表；
metrics.tokenizerEnabled=false 保留加权估算。
离线资源、固定版本、许可证和公有样例对照见
plugins/context-inspector/tokenizers/PROVENANCE.md。
安装新资源后需重新构建本插件客户端并重载 Web，浏览器刷新一次以清除旧原生弹窗。

实现依据：
- [DeepSeek token 用量与离线 tokenizer](https://api-docs.deepseek.com/quick_start/token_usage/)
- [DeepSeek completion usage 与缓存字段](https://api-docs.deepseek.com/api/create-chat-completion/)
- [OpenAI 输入计数接口](https://developers.openai.com/api/docs/guides/token-counting)
- [Anthropic 请求前计数](https://platform.claude.com/docs/en/build-with-claude/token-counting)

后两者说明部分厂商提供独立计数接口，但不能假定第三方 DeepSeek 渠道兼容。
本实现不会把私有上下文发到其他厂商的计数端点。

## 原生 Web 功能

打开主会话后切换顶部“轨迹”：

“系统”是历史记录行，不是固定按钮，只在初始提示词或提示词变化处出现，不会每轮重复。
在第880轮等尾部位置看不到它，不代表没有加载系统提示词。
顶部“调用”“轮次”的方框图标是展开/收起按钮，不是显示开关；调用只折叠工具记录。
请求编号详情没有系统提示词标签。搜索也只覆盖当前可见历史，不能替代加载更早历史。
原生定位需向上滚到当前列表开头并加载更早记录；若只想马上核对某次完整输入，直接打开下述请求归档更省事。

- 点击“系统”行（初始系统提示词或系统提示词已更新），检查“系统提示词”“工具”及更新差异。
  系统详情展示保留全文，列表预览才会截断。早期历史未加载时先点“加载更早的历史”。
- 点击“请求 #n”，查看“概述/选项/用量/计时”，核对该次模型、token、失败和重试。
- 用户、上下文和工具记录可分别检查原始内容、参数与结果。
- 输入框下方“当前估算”可点击，查看统一口径的系统/工具/消息构成与独立的最近 API 实报。
  未加载本插件投影时保留原生圆环；累计会话用量不能代替单次输入规模。

此版普通 Chat 明确隐藏 system-prompt 与普通 context 行：
dsh/packages/client/ui-chat/src/client/contract/chat-visibility.ts。
不能因聊天页没显示就断定系统提示词或注入上下文不存在。

原生轨迹是持久事件视图，可按当时 header、system/message、消息及替换事件还原状态，
并非每次 HTTP 请求的完整 JSON 查看器。request/context 主要是路由容量元数据。
原生系统提示词详情没有自动正文脱敏，不把认证错误遮蔽误解成提示词脱敏。

## 逐次模型输入归档

当前运行配置写入：
/home/ayerelysia/Elysia/Elysium/Elysia-Harness/homes/web/requests/

这是本项目 request-archive 插件提供的能力，不是 DSH 原生逐次 HTTP 抓包。
每个 JSON 的 request.messages、request.tools、request.toolHistory 和生成参数对应
llm/stream 钩子在适配器前拿到的组装结果。system 可能没有独立字段，
此时查看 request.messages 中 role=system 的 content 文本。
图片保留附件引用，字节在附件存储；适配器后续的格式转换、解析和 HTTP 序列化不在该归档中，
归档存在也不证明模型服务商已经成功接收。

只按 request.sessionId=elysia-conscious-mind 筛选；其他会话调用也可能写到同目录。
旧会话后来压缩/替换不会改掉这些独立请求文件。完整提示词不等于只读取五份固定前缀文件，
还包括当时历史、上下文注入、工具定义与工具回执。

## 2026-11-09 接入前只读核对（历史记录）

当时核对的请求文件为：
2026-11-09T08-06-57-079Z-05623bd1.json（北京时间16:06:57）。

模型 deepseek-v4.1-flash；主会话3471条消息、9个工具。
系统文本16415字符、42026 UTF-8字节；整个格式化JSON约3.37MB。
按ID检查856个工具调用与856个工具回执，未见重复call ID或缺失对应ID；
这不是完整时序协议验证，也不构成语义或记忆健康裁决。
文件大小、消息条数不能换算成准确token占比。

maxTokens=131072是输出上限，不是上下文容量。
具体请求的准确输入应核对该次 API usage，contextWindow 是容量元数据；
原生 contextPressure 可能保留历史残差，不能当成准确当前输入。
本次本机直接读取投影返回401，没有绕过既有浏览器鉴权，因此未取得准确当前占用百分比。

只读元数据接口为 POST /api/session/projections，使用DSH自有client-request封套与现有授权。
返回values中的contextPressure（pressureTokens/projectedTokens/contextWindow）、
contextBreakdown与tokenUsage。各字段更新不保证属于同一次请求，切换模型后须核对时点。
这次接入前只读检查没有输出主体/用户正文、修改配置、触发模型或发送平台消息。

### 索引接入与重建

先完成 request-archive 新 metadata hook 与查看器的运行挂载，再为旧归档指定一份
已知的最新同会话文件调用 SnapshotReader.seed。首次检查与实际挂载之间仍可能产生新调用，
因此挂载完成后再次核对最新归档文件名；不能把较早的首次 seed 当作当前最新。
seed 只重建派生指针，不修改原始 JSON。维护性 seed 须在归档索引写入器空闲时执行；
同一索引实例内会按时间保留较新指针，但独立进程不共享写入队列，不能并发 seed 与发布。
损坏指针可由显式 seed 修复，普通读取不会静默把损坏当成空结果。

SnapshotReader 的默认资源预算为单文件 8 MiB、缓存合计 32 MiB、至多 2 个 worker、
每页 64 KiB、worker 超时 10 秒；大于预算会显式失败。
纯 JavaScript worker 使用 execArgv:[]，不继承宿主的 tsx/--input-type 等参数。
归档时间按原始 ISO 字符串显示，Z 表示 UTC，避免浏览器环境格式化时区造成歧义。

Web 的 file: 安装目录中既有源文件可能与 plugins/ 下硬链接。
新增源码文件不会自动出现在该安装目录：部署必须仅补新增文件并逐文件核对 SHA/inode，
不能用整包覆盖或全 profile 安装卷入并行工作。新插件需要自己的 lib/client.js 构建产物。
