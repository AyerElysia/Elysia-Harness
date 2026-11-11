# 2026-11-09 上下文用量弹窗口径不一致

用户截图顶部约277K/1M（28%），分项约4.1K、1.6K、7.8K。
仅只读重放主会话v4日志到seq13578，共13579events；未激活agent、请求模型、
写正式存储或修改计量代码。只新增本诊断记录。

## 精确复现

contextPressure: pressureTokens=478167, sampledSurfaceTokens=212923, surfaceTokens=11910。
projectedTokens = 478167 + 11910 - 212923 = 277154。
contextBreakdown: 4108(system) + 1566(tools) + 7832(messages) = 13506。

UI大数取projectedTokens，不是下方三项求和。最后usage仍在seq13565：
未缓存输入215 + 缓存读取477952 = 478167；缓存仍占请求上下文。
它不是累计会话账单。顶部是上次提供方输入基准加减之后内容的字符估价；
分项独立按约每4个JS字符1token估算。P-H_sample=265244包含当时工具基线及估算差值，
不能全称为纯误差。压缩后尚无新主轮usage重锚，因此旧差值仍留在顶部。
顶部比分项总和多263648，不应仅凭中文粗算含糊解释20倍差距。

## 压缩与旧投影漂移

seq13575记录shadowedTokenCount=202947，等于真实选区node估价；
seq13576 replacement估价1919，净减201028，计量正确，代表这次压缩成功。
不能将此前17:39的失败尝试套用于后来的成功尝试。

六次无相邻shadow-price claim的user replacement：
13435/13436/13437/13438/13520/13547，真实delta分别
-190/-5235/-195/-192/-43/-43，合计-5898，却被bounded分项投影记为0delta。
另四次system rewrite净增30，breakdown重计而pressure记0，解释两者surface差30。

真实存活node估价为4108(system)+1919(checkpoint)+15(tail assistant)=6042；
含工具1566共7608。这仍非模型精确分词。13.5K分项本身也残留5898旧价格。

## 代码及后续处理

ui-conversation/context-occupancy.ts:18取projected；
skeleton/ContextMeter.tsx:100仅按分项比例给总条分色。
token-meter/usage-projection.ts:194-215实现usage锚点+surface差值；
estimate.ts:13固定每4字符估算；surface-projection.ts:88无claim替换记0delta。
compaction-basic/region.ts:376-380影子价使用heuristicTokens。

可复跑脚本为 /tmp/elysia-token-projection-audit.mjs，
仅scanLog+官方纯projection与surface函数，不打开backend或写正式cache。

后续须区分UI模型回报、基准推算、字符估算及统计时点；
压缩后旧基准应显式失效或重新校准；替换生产者须同步计量声明，
或统计从真实surface重建。不能将分项按比例放大后声称是精确分类token数。
本次仅诊断，没有改计量代码或历史。


## 修复与统一验证

采用插件拥有的 elysiaContextMetrics 投影与 composer.dock 仪表，不修改 vendored DSH。
当前总量只根据保留 surface 计数；历史实报单列。使用带完整性校验的固定版本官方
DeepSeek V4.1 Flash tokenizer，公有样例与原生 Python tokenizers 0.22.2 对照一致。
未知路由、超预算段落和未实现的附件计数均明确标记估算或部分；没有额外远程计数请求。

只读回放同一 session.v4.jsonl.zstd 的 13,579 事件（seq 0..13578）：
- 旧 projectedTokens：277,154；旧分项：4,108 + 1,566 + 7,832 = 13,506。
- 修复当前估算：10,002 + 1,699 + 2,238 = 13,939。
- 最近正数 API 实报来自 seq 13575 的压缩调用：465 未缓存 + 478,080 缓存读取 = 478,545 输入；
  ISO 2026-11-09T10:14:16.591Z。它属于压缩前专用请求，不能替代压缩后当前输入。
- 只读快照前后大小/mtime 未变，2.50 秒完成；投影检查点 schema 校验通过。
- 插件 12 个测试文件、75 项测试通过；只构建自身 client bundle。

- 增补 image/offload 表示版本判断，消息 seq 不变也不会误报输入未变；stateVersion=2。
- 额外验证真实插件卸载清除投影与计数器、随后重新挂载可用；
  前端/host 的 noEmit 检查均零诊断。
- 2026-11-09 19:02:52 +08 在确认 UI 空闲、uid/cwd/父子关系/3299 监听后，
  对旧 Web PID 1523436 / tsx parent 1523415 执行一次 SIGTERM；
  原子核对旧实例退出与端口空闲后，用原父进程参数与环境启动一次，
  新 tsx parent 1742817 / Web 1742830，未启用守护、自动启动或恢复循环。
  复用原环境，不执行共享 dirty 启动脚本。
- Web file: 安装实际是本插件源码 symlink，构建仅覆盖其 ignored lib/client.js(.map)。
  进程仍监听 127.0.0.1:3299，新增日志未出现本插件加载错误。
- 本机旧 SSH 转发已结束，为浏览器验收建立一次新的 loopback forward，PID 74976；
  这是可关闭的单次连接，不是服务自动恢复。
- 已使用现有登录浏览器刷新并打开“上下文统计”：
  当前 13,939 / 1,000,000，三项 10,002 / 1,699 / 2,238；
  单列压缩调用 API 实报 478,545、缓存 478,080、未缓存 465 与 ISO 时间。
  模型、工具、会话累计用量按钮仍可见；未触发新模型调用或平台消息。
- UI 证据保存在本机 C:/Users/26652/.codex/artifacts/context-meter-fixed-20261109.png。
  生命周期记录 /tmp/elysia-context-meter-reload.json 只含 PID 与日志偏移等元数据。
- 回滚可仅关闭 metrics.enabled（不卸载完整提示词查看器），或回退本次插件文件并重建/重载；
  不需要改写会话、主体文件或原始请求。旧原生投影保留供 DSH 其他消费者使用，
  本次 UI 修复不会改变其压缩触发决策。所有代码与文档暂留工作区，未提交/推送。
