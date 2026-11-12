# 本机 Web 通话入口接入记录（2026-11-12）

## 当前结果

已将 `@elysia/voice-call` 通过现有原生插件管理接口加入 Spark Web profile，并在用户本机 Chrome 打开“实时通话”面板。已观察到隐私选项按用户此前决定勾选、“开始通话”可用、连接“未通话”、麦克风“未启用”、用量0；浏览器页面已保留在前台。

**这是入口与配置就绪，不是真实音频通话验收。** 本任务没有点击开始、开启麦克风、发起 Realtime call 或合成测试音频；WebRTC、实际听感、插话及实际挂断仍须用户开麦短测。

## 授权与范围

用户要求现在接入并在本机浏览器查看；另明确同意复用本机现有代理作为 Spark → OpenAI 专用出口，以及与“ElyHarn重构”任务协调共享服务加载。

只启用 Web surface；插件源码默认仍 `enabled:false`，TUI未改。主意识、主体文件、固定参考音频、聊天模型路由与共享 Breeze 推理模式未修改。key仍只由既有受控引用 `OPENAI_REALTIME_API_KEY` 提供，文档、浏览器及源码不含其真实值。

## 发现与修正

1. 本机原有3299转发已断，浏览器原先显示断线。核对 Spark3299准确 owner后，人工恢复本机 loopback SSH 转发。
2. Spark直连OpenAI在认证前发生TLS/ECONNRESET；无认证curl同样HTTP000，不能据此判断key错误。用户授权后，复用现有 MyClashCore7878，经临时 SSH 反向转发到 Spark loopback17878。
3. 新增插件作用域 `createOpenAINetwork`，fetch仅官方HTTPS，WS仅官方Realtime路径；强制TLS验证、拒绝重定向、有界握手和关闭。不改环境变量或全局dispatcher，Breeze仍走本机7862。
4. 通过原生LocalCredentialProvider内存resolve同一受控引用，只读GET官方目标模型元数据返回HTTP200，认证被接受且目标模型可见；凭据文件inode/size/mtime未改变。没有因此宣称Realtime写接口或媒体已验收。
5. 并发“ElyHarn重构”任务正在修改/加载时间及计划模块，因此没有盲用全profile reconcile。征得用户协调授权后，等待其明确确认“可以加载voice”、主意识在线空闲、之后不再修改相关源码/profile或重载，再接入。
6. 早期主意识fiberPhase:null是真实过渡态，不是字段缺失或key故障；最终源代码、实际lib和返回schema核对一致，主意识已active。

## 部署操作与证据

精准新增 Web profile 的一项file依赖、一条自身symlink与voice覆盖行（enabled及专用loopback代理）。既有所有并发配置字节保留，未安装全仓依赖、未重写锁文件。selected bundles由原生setBundleEnabled持有，不预先伪造选择结果。

原生写API仅一次：

- application: applied；changed: true；restartReason: null；errorCode: null；warningCount: 0。
- voiceActive: true；state enabled/credentialConfigured均true，connection idle。
- Web PID270604及进程starttime在本次启用前后相同；主意识插件前后active，原生主session的Agent前后可用且空闲。
- 锁文件及11121项非voice源码stat快照在本次启用前后未变。
- 原生返回未暴露pending数组，pendingCount未知；不能编造为0。
- 本任务未重启Web。此前服务重载由已协调的重构任务执行；不能把两者混为“本轮完全没有服务重载”。

## 定向检查

本轮最终整包：12个文件、141项通过；src+tests严格类型检查通过。新增OpenAI网络28项，Realtime含HTTP错误body取消19项。原聊天语音的send-voice与breeze-transport合计19项回归通过。均为临时存储/假网络的轻量定向检查，不写正式数据、不占用正式GPU。

Breeze7862/7863只读health均HTTP200、24kHz；gateway空闲、queue0。未发送额外平台消息、未调用正式合成。

## 临时连接与回滚

本轮创建的 Windows SSH owner：PID56924（本机3299 → Spark3299），PID71296（Spark17878 → 本机已存在MyClashCore7878）。它们仅loopback监听、人工启动、无自启/自动重连；本机代理及连接需保持运行。回收前须重新核对准确进程，不按旧PID盲杀。

可通过原生插件管理停用voice bundle；不删除原生Session或权威记录。需要移除时只移除本任务一项依赖、symlink与override，不回滚其他并发修改或共享锁文件。凭据可在同一引用处替换，无需把新key再贴到聊天。

使用及重新连接见 [本机操作](../operations/voice-call-web.zh.md)；之前离线阶段见 [MVP实施记录](voice-call-mvp-20261112.md)。

## 用户首拨失败的后续修复

用户随后自行点击开始并提供失败截图。其原生基础设施记录显示：2026-11-12 05:21:42.586请求开始，05:21:42.654以`start_failed`结束，仅68毫秒；`providerCreated:false`、用量0。请求到达服务器证明这次浏览器播放器、麦克风获取及本地连接准备均已通过，不能把此例归因为麦克风没授权。该尝试未创建OpenAI通话。

使用临时SOUL及真实Web通用hooks复现两项接线问题（不读取正式SOUL正文、不调用云端）：

1. WorkingDirectory的外层around hook在voice局部过滤返回之后重新加入required context，触发SOUL-only断言。修复为在最终provider边界再次构建局部projection，剔除contexts/tools/variables，仍严格检查唯一literal standing SOUL section，不更改全局assembly或主意识提示。
2. 全局LocalFileReference的agent-created hook读取`ctx.tools`，voice未声明该service inject。只补`tools`依赖声明以满足原生hook，不给Realtime注册或执行任何工具；provider仍空工具。

新增真实Web hooks回归覆盖context回填、缺inject、SOUL重新读取及零工具执行。此前bare-context测试没有覆盖这一生产hook组合，这是首轮检查的盲点。

另补前后端安全诊断：固定启动阶段、白名单异常名/服务代码、本服务HTTP与可选真实上游HTTP状态；不显示原始异常、上游body、SDP、凭据或设备名。失败后保留首个诊断、不自动重拨。PCM工作线程经生产压缩到隔离VM的两项检查通过，无播放器运行代码改动；没有把先前未复现的播放器时序猜测当成本次原因。

本次源码回归：14文件、166项全部通过，完整严格类型检查及client构建通过；独立只读审查也未发现SOUL-only、空工具或脱敏边界阻断。均为临时存储/假网络检查，本次代理没有启用麦克风、创建真实通话或调用正式TTS。

加载协调：原Web PID270604之后由并发owner更换为337876（05:33:00启动），部分voice修复晚于其启动，不能仅凭进程在线宣称修复已加载。旧部署基线作废但不覆盖伪造；发现非voice新增pass.ts及相关测试后，等待其owner确认当前源码已加载、无待加载更改。原生公开入口为全profile reconcile，并非公开的单插件源码reload API。下一步仍须记录实际加载结果和用户开麦短测，不能将离线通过升级为真实通话验收。

## 再次失败与专用身份隔离

取得owner确认后，一次原生协调加载返回`applied/changed:false/restartReason:null`。实际安装的plugin-manager与HMR实现已读：`changed:false`只表示profile磁盘内容没变，不会跳过模块文件比较/失效/重新导入；因此不能把它解释为“没执行加载”。PID337876、profile/lock及11122项非voice源码指纹在操作前后相同；没有公开模块替换列表，日志中也没有可用生命周期行，不冒称这些空日志是只重载voice的正面证明。

用户再次亲自开始，05:48:34.882–05:48:34.909以`start_failed_agent_prepare`结束；provider未创建、cleanupFailed:false、agentRegistered:false、无模型调用。原始异常没有保留下层本地stack，不能据审计断言它就是某一条具体throw。

查明两项需要处理的事实：

- 05:39整包通过后，index/controller等文件在05:45有后续Q8接线更新，丢失tools声明和部分安全阶段诊断；05:49真实Web hooks回归与随后完整回归分别抓到这些退化。只合并修复项，保留新增Breeze专用URL/Q8接线，没有回滚整个文件或改聊天TTS。后续05:52–05:53又有合并写入；写入来源未做进程级归属取证，不指定或指责某个并发owner。
- 审计虽说已关闭，原生session/list仍报告专用ID有live idle Agent。此字段直接来自真实registry对象相等判断，不是缓存的“可以恢复”能力。现有wire元信息不足以证明该Agent的精确创建owner。已从源码闭合一条允许接管的路径：浏览器恢复选中会话/历史流重连→session.follow→冷快照后promote→默认AgentFactory.resume；本次具体由哪一次follow触发仍未知，不把该推断写成请求日志事实。

在voice插件增加`agent/created`公开串行发布钩子，仅保护`elysia-voice-call`：要求本插件生命周期拥有的真实VoiceAgent，普通create/resume被固定安全代码拒绝并由原生工厂回滚。钩子在第一次异步等待前注册；没有替换默认factory、伪造subagent origin、修改dsh源码或改变其他Session。

新增5项真实AgentLoop工厂create/resume及临时JSONL测试，验证registry、Session及写锁回滚、本插件VoiceAgent允许、其他ID允许、foreign owner拒绝与hook卸载。缺tools负例新增显式dispose后registry/Session均空且同ID可再建的检查，排除这一覆盖路径中的custom清理泄漏。

最终冻结检查：15文件172/172通过，严格类型检查与构建成功；45项源码/测试/脚本/包配置SHA前后完全相同。冻结记录`/tmp/voice-source-validation-20261112T0608-ownership.json`。这些是离线/native生命周期验证，不是真实音频验收。

注册表没有按ID任意销毁Agent的公开能力，disposer仅由创建handle的owner持有。部署安全门因此拒绝无依据的再次HMR；改为先协调一次受控Web重启清旧owner。06:03:53重构owner再次确认主意识空闲、待输入0、无待加载更改；重启前仍须重新核对准确进程、端口、所有Agent空闲、45项voice冻结及非voice/profile旧协调指纹。无关`dsh-web.service`的MainPID2602不是此Web owner，不得重启它。实际执行结果单独记录，不把计划写成已执行。

## 06:27 受控重启与当前验收边界

重启预检曾拒绝profile哈希差异，未发信号。进一步证明：当前cordis.patch.yml完整SHA为`223679446d1889d09e0328d9ea853f58b24ddaaaf65d80f5436172f188bae6a4`，只在内存删除voice stanza唯一新增的`breezeServerUrl: http://127.0.0.1:7865`行后，精确恢复旧基线SHA。故仅接受这项voice专用已存在配置，并保留旧协调基线；其他profile字节不变，不泛化放行未知配置。

期间同一旧Web的controller被其他加载重置为空闲，但专用Agent仍在线。最终前置允许明确无活动通话的idle/null状态，或已知旧failed终态；仍拒绝活动、未知失败与cleanup_failed。实际动作前两次重新读取准确进程身份、两端口、主意识native精确inbox为0及所有live Agent空闲。

2026-11-12 06:27:01，一次性重启仅TERM准确旧Web child337876；旧child及启动器337865自然退出、3299/3300释放后，原argv/env/cwd（私有内存保留、不输出凭据）单次启动新launcher556877/child556889。没有SIGKILL、重复重启、自启修改、Session删除或Breeze服务重启；无关systemd MainPID2602仍在。one-shot marker防止重复执行。

一次性脚本最后因“API operator cookie GET根HTML必须200”的过严健康探针退出1，不伪造为脚本全成功，也未因此重启第二次。独立源码核对说明：`/connect`签发version2 API cookie，静态页面认证只接受version1浏览器cookie，同API cookie访问根页预期401、无Location；两者不能混作同一种验收。随后独立原生API检查与本机Chrome实际刷新、进入通话面板均成功。

后验：3299/3300准确归新child；主意识Agent available/idle、next-turn及next-step均0。voice enabled、idle/callId:null/errorCode:null、capture inactive，专用AgentAvailable:false；浏览器实际刷新后再读仍false，旧占用未被重新抢回，页面“开始通话”可用。45项voice源码、11122项非voice指纹均未变，profile仅上述精确允许行；两份基线文件hash也未改变。

06:31:52仍无新call-start，最新基础设施记录仍为05:48旧失败。已请用户亲自再试并保留浏览器；自动化未替用户开麦。**当时仅确认本地会话阻断修复已加载及入口可用；未验收真实通话。**

## 17:05 再拨被旧 10 秒浏览器时限截断

用户亲自重试。服务器工程记录 17:05:30.662 收到请求，17:05:40.587 以 `start_aborted` 结束（9.925 秒），没有取得 provider handle，无用量或播放回执，`cleanupFailed:false`。截图 `server_start / TimeoutError` 且无 HTTP，与浏览器自开始时 10 秒取消相符。旧审计没有足够阶段细节：不能断言到底卡在会话准备还是上游建连，也不能用 `providerCreated:false` 证明没发出创建请求。Spark/Windows 原有 SSH 和 Clash 仍存活；无认证 HTTPS 检查一次 TLS 超时，随后 Spark 和本机收到预期 HTTP401、总耗时约 4.7–5.6 秒。这只能证明链路有波动、随后可达，不能判定已配置密钥的有效性或上游实际调用结果。

修复：拆分浏览器开始请求 100 秒、服务端启动 30 秒、模型完整建连 25 秒与单步 15 秒；本地操作 10 秒不变。浏览器取消立即传播，成功即清除启动定时器。增加固定启动阶段与终态上游子阶段，不记录 SDP、凭据、模型输入或原始错误；已获取上游 call ID 但初始化失败时仍执行挂断补偿，无法确认补偿则保留清理失败并阻止重拨。不自动重试、未更改模型、代理配置、参考音色或 SOUL。

验收：15 个文件 177 项离线测试通过，严格类型检查和前端构建通过。覆盖模拟 13 秒串行建连成功、服务器超时与用户主动取消、清理失败保护及普通请求保持 10 秒。通过原生加载流程应用一次（`applied`，无须重启）；Web PID556889 前后相同，主意识正常空闲，voice 由旧终态恢复到空闲，锁文件、profile、11122 项非 voice 源指纹不变。Breeze 聊天与通话健康 HTTP200。新版真实拨号尚未验收；浏览器自动刷新不可用，用户须手动刷新后再试。
