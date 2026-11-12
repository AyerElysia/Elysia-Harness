# pass 未结束轮次导致重复调用（2026-11-12）

## 事故与根因

用户报告一条KOOK消息在send_text之后出现大量连续pass。05:20:32北京时间只读确认主意识running、同一turn1096已进入step25，step5至24连续pass，间隔约6–8秒；没有turn/end。每步都写入time-context与elysia-calendar-context，单次模型上下文约186k、主要为缓存输入。此处保留工程事件，不复制私人思考正文。

根因是conscious-mind/src/pass.ts只返回{passed:true,reason}，从未调用公开ToolRunContext.concludeTurn()。原生DSH在工具调用之后，仅当成功结果声明concludesTurn才请求completed，否则继续下一step；模型再次选择pass，形成空转。

新增clock/calendar是在实际pre-step后追加的可追溯上下文，不进入inbox，不独立调用send/followup/steer，也不会重置仅针对真实user输入的重复工具提醒。它们会在错误持续的step中继续出现，但不会阻止一个正确终止的轮次退出。问题无需通过移除时钟、删除历史、关键词识别、pass理由去重或清空真实待处理输入掩盖。

此前时间/计划验收覆盖了事实输入、计划往返和普通文本收尾，但漏掉选择沉默后的真实退出；本次已向用户明确说明这个验收缺口。

## 最小修复

仅让pass成功执行调用exec.concludeTurn()，保留参数、结果、reason与渠道副作用语义，工具说明明确“选择沉默并结束当前轮，等待新输入”。成功结果先按原生工具流水落账，再由原生loop按真实pending input决定结束或继续；不自己实现消息优先级、调度器或打断规则，不修改DSH实现或主体文件。

修复source SHA256=4043b1eafdc3c0560c44c745125fb1a490d243750e0ae20fc4e90de90b2f7247；clock/calendar source b258b27ec4cd5b58c4e0cb354310bc7cbf7655d5f776a6b0d590e43732f6e8f9保持不变。

## 定向验证

新pass-completion隔离集成使用真实主意识compose、完整standing配置、双clock、原生agent loop、JSONL会话和本地假adapter。send_text→pass应恰好2次模型请求；pass成功结果已落账、没有新输入时进入idle，随后事件seq与request数保持稳定。另在pass工具执行期间注入真实steer，确认原生机制继续处理且不丢输入。

修前2个新用例中1失败（实际出现第3次请求）/1通过，报告/tmp/elysia-pass-completion-before.json；修后7个相关文件共33项全部通过，报告/tmp/elysia-pass-completion-after.json。正式wiring和所有本轮修改测试的safe noEmit覆盖533文件、零诊断，报告/tmp/elysia-pass-completion-typecheck.json；未做全仓构建或生成src编译产物。main-session原pass单元fixture仅补原生concludeTurn spy与断言，其他并发改动保留。

## 生产观察与恢复状态

主意识turn1096在05:23:11.569以aborted/user结束，seq18217。原取消工具回显截断，未能恢复该RPC回执与requestId，故不将此事件强行归因为某次工程RPC，不伪造审计字段，也不重复取消以补证。

1.211秒后出现turn1097；seq18222是一条新的真实user输入，之后send_text并重新进入旧pass空转。截至05:26:17已step27。不能把这个新turn误记为clock自行唤醒或取消失败；新工作当时未被擅自再次取消。只读证据/tmp/elyharn-pass-stop-observed-9c99aquu/observation.json，目录0700/文件0600。

修复部署与真实terminal验收已通过。05:31:09重新核对旧Web270604/launcher270546及双端口归属；17个会话仅main运行，1097已step69，最近成功工具均为pass，next-turn/next-step inbox为空。voice为failed但capture inactive/generation idle/playback stopped，无活动通话；直播onAir=false/broadcast idle。此基线不扩大为voice故障诊断或修复。

05:32:12仅取消已核实的1097一次：工程requestId=codex-pass-fix-cancel-1097-b4f74b49970e44a6b789714672f5bb4f，原生accepted=true，seq18766 turn/end aborted/user；随后确认main available且idle。回执先保存/tmp/elyharn-pass-fix-0ixk7n5u/cancel.json，归因完整，与先前无法恢复的1096回执分开记录。

所有会话空闲后仅向准确Web child发送SIGTERM，使用原生关闭持久化、父子正常退出及3299/3300端口释放，再保留原argv/env手动单次启动。新launcher337865/Web337876，主意识恢复available/idle、17会话idle、voice idle、直播off。未安装或构建，未改profile/time/calendar，未重启其他服务。安装pass.ts与源码已是同一硬链和SHA4043b1ea…，故只留私有字节备份而未重复写；该备份已经是修复字节，不冒称修前版本。

真实工程输入requestId=codex-pass-completion-bd78772577c642bea4fe2964ed1d991d，明确Codex工程身份，只请求选择pass结束本轮，不给reason答案，不授权平台外发或主体文件写入。实际归档 homes/web/requests/2026-11-11T21-33-44-785Z-fa73a60d.json 命中本次nonce和main，工具说明已包含“结束当前轮”。

- turn1098只有step1、1次模型请求、1次pass；seq18778工具调用，18779成功passed=true，18781以completed结束（北京时间05:33:53.804）。
- 两种clock source各只注入1次；工具成功结果先落账，没有为展示pass结果额外调用模型。
- 后续连续25秒采样均idle，没有新真实输入、新turn、第2step或额外clock；没有平台工具调用。
- 所有一次性观察脚本与连接结束，无后台轮询；最终证据 /tmp/elyharn-pass-fix-0ixk7n5u/final-acceptance.json，目录0700/文件0600。该观察证明无新输入时不自续轮，不将新的真实消息误判为复发。

正常新输入的继续处理另外由本地真实steer集成覆盖；没有通过删除或屏蔽输入得到空闲。

## 变更与恢复

两份说明文档的字节备份与精确增量：/tmp/elyharn-pass-completion-docs-69y_4qbr。修前tracked pass字节另存/tmp/elyharn-pass-fix-0ixk7n5u/tracked-pass-before.ts，SHA256=50c17bb7560d6c4ef4dc4f77af6d7e8eb263b99cf7e10020b470ca01de13300b；精确源码增量pass-completion.patch在同目录。源代码、测试和记录保留在原checkout，不暂存、提交或推送。安装副本可能与源码逐文件硬链，部署时核准确pass.ts SHA，已相同则不重复写；不进行安装、全仓构建、改profile或重启其他服务。

需要恢复时只逆向本次pass终止接线与精确测试/文档增量，并在重新核对owner后受控重载。旧行为会重新暴露该循环，不能作为正常长期状态；历史pass与模型活动不删除。
