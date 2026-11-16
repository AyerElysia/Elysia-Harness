# 北京时间上下文缺失修复（2026-11-12）

## 问题与诊断

用户报告自己的北京时间约04:39，而爱莉收到的时间不同。只读检查时，同一瞬间 Spark UTC=2026-11-11T20:40:16+00:00、系统本地=2026-11-12T04:40:16+08:00；Node默认 Intl 时区也为 Asia/Shanghai。Web未设置TZ，正确继承系统时区。服务器时钟没有慢八小时，不应修改系统时间或把epoch整体加八小时。

实际主意识请求归档 homes/web/requests/2026-11-11T20-30-38-732Z-6d6c50f7.json 中 time-context 消息数量为0；近期 Web user-rpc 源元信息虽然带 clientTimeZone=Asia/Shanghai，却未转成模型可读时钟。自定义主意识和Web elysia preset没有装配原生 dsh-time-context；standing prompt按字面读盘、不插值，也不负责计算当前时间。

原生计划提示包含 occurrence_at 的UTC ISO时间。上轮实际计划记录20:30:30Z与北京时间次日04:30:30+08:00是同一瞬间；seq17792的event.time和投递回执仅差3ms。缺口是模型没有本次调用的当前时间和时区参考，不是计划调度错时钟。不能用UTC字符串外观证明主机时间错误，也不能将模型回答本身当成时钟证据。

## 修复

新增conscious-mind/current-time作用域子插件，复用原生 dsh-time-context，明确timeZone并固定refreshIntervalMs=0：每次实际agent/pre-step取Date.now，形成可追溯source.kind=time-context的输入；没有新增timer或空闲唤醒。默认/无浏览器时区时使用Asia/Shanghai；主意识和Web elysia preset都显式配置上海时区。配置进入主意识装配fingerprint，失败会回收已挂载子插件。

遵循原生浏览器规则：同一turn存在唯一合法user-rpc.clientTimeZone时优先该时区；无浏览器元信息的QQ等IM消息和计划唤醒使用Shanghai fallback。时间读数携带完整日期、+08:00与[Asia/Shanghai]，避免跨日或时区歧义。原始UTC ISO存储、请求归档文件名、计划scheduledAt等仍保留原生格式。

source.kind=time-context不会被主意识仅针对agent-instructions/runtime-context的隔离过滤删除，也不通过改写complete standing正文注入。没有修改SOUL、USER、MEMORY或日记。原生timeContext投影注册按key/stateVersion引用计数，多作用域能并存和独立卸载。

## 日历补充

第一次实际报时中，原生读数为2026-11-12T05:00:28+08:00[Asia/Shanghai]，模型正确报告日期、时间和时区，却额外回答“星期三”。该日实际为星期四；原生time-context没有weekday，不能把模型附带的日历推算当成系统时钟错误，也不能把整段回答无保留记为正确。此问题已向用户明确说明，第一阶段原始证据保留。

current-time子插件保留原生clock，另通过pre-step追加独立elysia-calendar-context snapshot。一次Date.now配合Intl.DateTimeFormat的zh-CN/gregory/latn，在配置时区计算完整日期、星期、时分秒和GMT偏移，并附同次采样的UTC ISO。它不解析或重写原生文本，不手算+8，不新增timer；只为精确agent owner追加。日历和原生clock分别标明各自采样与时区；当browser指定其它zone时，原生选择仍生效，日历仍明确显示配置Shanghai，不伪装成同一zone或同一毫秒采样。

## 验证状态

6个相关测试文件最终31项通过，包括7个真实pre-step时钟/日历用例、主意识装配、完整standing正文、作用域隔离、标准preset共享投影的两种卸载顺序、真实模型adapter看到带+08:00[Asia/Shanghai]的time-context及日历事实，以及现有计划往返和工具六例说明回归。用例覆盖北京时间跨午夜和星期切换、连续step刷新、合法浏览器zone、无browser zone的计划fallback、无scope/缺参/非法IANA拒绝、日历精确owner与descendant隔离、UTC browser时原生UTC与配置Shanghai日历各自标明时区。计划集成测试新增实际请求中的clock/calendar断言，main-session mock同步新增固定配置/插件及失败回收断言。

原生clock阶段先通过29项；补日历后的最终结果 /tmp/elysia-current-time-calendar-regression.json，两者重叠不相加。正式root index/main接线和本轮全部修改测试的安全noEmit类型检查覆盖532文件、零诊断，结果 /tmp/elysia-current-time-regression-typecheck.json。未进行全仓构建，没有生成src编译产物。

额外扩大类型检查到两份本轮未修改的旧测试时，file-capabilities-integration和tool-registration存在5条既有fixture类型诊断（subprocess/sandboxPolicy Context声明及旧async plugin spy）。通过只读TypeScript compiler overlay在内存中移除clock接线，5条仍完全相同，见 /tmp/elysia-clock-baseline-typecheck.json；未改这两份测试或扩大业务修理，不宣称全仓类型检查通过。

最终实际报时验收通过。两次输入均明确Codex工程身份、限定当前Web工程验收，未提供当前日期、时间或正确星期答案，不授权计划、平台外发或主体文件写入。第一阶段三个报时字段正确但额外weekday错误，第二阶段同时验证系统输入与四个回答字段。

第一阶段requestId=codex-current-time-e145300f3e0a4452bdb4a074b8a53cbb；实际归档 homes/web/requests/2026-11-11T21-00-28-952Z-edef054c.json，seq17854出现time-context snapshot，读数2026-11-12T05:00:28+08:00[Asia/Shanghai]；同一源事件epoch对应05:00:28.941，941ms为秒级截取差。模型seq17856的日期/时间/时区正确，但额外星期三错误，未将此整段误记为完全通过。证据 /tmp/elyharn-current-time-94och415/final-acceptance.json；此前阶段metadata版本亦保留。

第二阶段requestId=codex-calendar-506cc9ea47884d04a8d9ad055c1fdbb2，输入未提供答案。实际归档 homes/web/requests/2026-11-11T21-10-29-633Z-cf08d98f.json，正确main与本次nonce，包含time-context及elysia-calendar-context两个独立snapshot。

- 日历采样epoch1794431429576，对应北京时间2026-11-12 05:10:29.576，星期四；Intl产生的日期、星期、时间均与epoch机械核对一致。日历源事件晚28ms。
- 原生clock为2026-11-12T05:10:29+08:00[Asia/Shanghai]，与源事件差602ms，属于秒级格式精度；两来源各自采样，不宣称同一毫秒。
- 爱莉seq17869实际报出2026-11-12、星期四、北京时间05:10:29、Asia/Shanghai/GMT+08:00，四字段均正确，并明确纠正前一次的星期误答。05:10:38.643 turn/end，最终seq17871。
- 原生main API确认agentAvailable=true、running=false；本次toolCalls=[]，没有计划创建、平台外发或主体工具写入。所有一次性请求与observer结束，无后台轮询。

最终证据 /tmp/elyharn-calendar-stage2-3kdxfiyy/final-acceptance.json，SHA256=f187c05b9b27d7741bec12d531231e22e63979a917cf208fa793539141e92046；原始观察 observation-1794431499597506259.json。验收结论针对实际请求准备阶段采样读数；模型生成回复所需时间会自然使显示时刻早于用户看到回复的瞬间，不将此延迟误判为时区漂移。

## 受控部署与交接

两次均重新核对准确Web/tsx父子、uid1000、Harness/dsh目录、Node22、原argv/env及3299/3300端口归属；16会话idle且onAir=false后，仅SIGTERM准确Web child，使用原生正常关闭，约200ms父子退出并释放端口，再按原入口单次手动启动。没有force kill、循环拉起或后台恢复，没有重启NapCat、Python Elysium、Breeze。

| 阶段 | 旧Web / launcher | 新Web / launcher | ready | main连续性 | 精确安装刷新 |
|---|---|---|---|---|---|
| 原生时间 | 87848 / 87837 | 240918 / 240907 | 6.035s | seq17847→17848 | manifest与新增current-time.ts |
| 日历补充 | 240918 / 240907 | 270604 / 270546 | 6.971s | seq17858→17859 | 仅current-time.ts |

source与安装副本的index/main-session逐项SHA相同，未改其副本；最终current-time.ts SHA256=b258b27ec4cd5b58c4e0cb354310bc7cbf7655d5f776a6b0d590e43732f6e8f9。第二阶段manifest已与source相同，无须重复刷新。两个私有目录中的reload.json及installed-refresh.json保留准确备份、存在性、字节与生命周期证据，目录0700、文件0600。

原生timeContext投影是host-only，没有wire字段，因此会话投影API不展示该key属于预期，不能据此推断未加载。是否生效以实际model request中source/内容和真实报时为准；主意识是否在线以registry派生的agentAvailable/running等API及实际往返为准，不能只凭bundle列表的fiberPhase外观判断。

通话接入任务已明确等待本次加载。最终四字段验收通过且主会话空闲后，root在本任务进度明确交接“可以加载voice”；此后本任务仅写验收记录，不再改已加载主意识源码/profile或调用重载API。阶段2final-acceptance记录的是root交接前快照，后续交接补记 root-handoff.json，不改写旧验收文件。

## 变更与恢复

接线前main-session.ts、index.ts、Web profile逐字备份：/tmp/elyharn-time-context-wiring-kua58rmc。依赖元数据精确增量：/tmp/elyharn-time-context-metadata-8y36jqrx；current-time导出增量：/tmp/elyharn-current-time-export-6s5sr95n；README与架构说明精确增量：/tmp/elyharn-current-time-docs-66zc_472；日历说明增量：/tmp/elyharn-calendar-context-docs-25eu95h4。共享工作树中的其它修改保留，未暂存、提交或推送。

profile安装的conscious-mind采用逐文件硬链副本；新增src/current-time.ts不会自动出现，source manifest已与安装副本断硬链。受控停止Web后须精确刷新安装副本manifest与新增模块，并核对index/main-session字节；不需要全仓安装或构建。受支持DSH CLI的installation resolver已经供应原生time-context包，不能以副本裸Node缺少peer链接推断正常profile不可启动。

恢复只逆向本任务的接线、说明、依赖元数据与精确安装副本变更，并在重新核对生命周期owner后重载；不改系统时钟、主体文件、原始历史或其它线程改动。

## 2026-11-16：合并为单一极简时间

### 需求与实现

主意识每次收到新消息后，原生 `time-context` 与自定义 `elysia-calendar-context` 曾分别注入一条时间，内容也包含星期、秒、UTC 和时区等冗余信息。本次将主意识与 Web `elysia` preset 的时间输入收束为一条自定义时钟，不再为这两个作用域挂载原生 `dsh-time-context`。固定配置时区为 `Asia/Shanghai`，不再按浏览器时区分支；正文严格为 `YYYY/MM/DD HH:mm`，不包含其他说明。

`current-time.ts` 在挂载时清理所有仍可见的旧原生/自定义时钟，在每个精确 owner 的实际 `agent/pre-step` 中先清理上一条可见时钟，再加入本次极简时间；卸载时也清理当前可见时钟。清理使用空 surface replacement，原始事件、详细旧文本与来源引用继续保存在耐久日志中。没有 timer、额外唤醒或 standing prompt 正文修改。

### 第一版真实验收暴露的问题

第一版仅清理原生 `time-context`，requestId=`2026-11-16T15-39-27-169Z-a755ded8` 中，新时间已经简化为 `2026/11/16 23:37`、`2026/11/16 23:39`，但旧详细 `elysia-calendar-context` 仍留在可见投影，因此该版不能视为完成。第二版把旧自定义快照也纳入相同的 surface replacement 清理，并新增对应回归断言；验证脚本只统计正文非空的可见时钟，避免把空 replacement 误报为第二条时间。

### 测试、部署与真实验收

第二版定向回归通过：3 个文件、30/30 项（`current-time.spec.ts`、`main-session.spec.ts`、`standing-prompt.spec.ts`）。覆盖跨分钟/跨午夜替换、可见上下文始终只有一条、卸载后为零、浏览器与计划入口使用同一固定时区、原生与自定义旧详细时钟退出可见投影但保留历史、普通及 descendant Agent 隔离，以及主意识装配与固定提示词回归。

重载前主意识 `agentAvailable=true`、`running=false`，LiveKit `activeCallRooms=0`、`occupied=false`；随后执行既有 `scripts/dsh-web-restart.sh` 受控重载。没有重启旧 Python Elysium，也没有向 QQ、KOOK 或飞书发送测试消息。

第二版真实主意识 Web 自检的 requestId=`2026-11-16T15-49-48-328Z-371b274a`。请求中正文非空的可见时钟数量为 1，来源仅为 `elysia-calendar-context`，文本严格为 `2026/11/16 23:49`；本次新增非空时钟事件数量也为 1。模型回复“极简时间检查完成”，`toolEvents=[]`，没有工具调用或外部渠道投递。验证以当前真实模型请求的可见投影为准，不要求整个等待窗口没有其他主意识活动。

验收后主意识与 `@elysia/gemini-cascade` 均为 enabled/active，主 Agent `agentAvailable=true`、`running=false`；LiveKit 仍为 `activeCallRooms=0`、`occupied=false`。四个 Office Skills 的作用域屏蔽保持原状，本次未回退 Skills 相关实现。

## 2026-11-17：同一轮的工具步骤不再重复注入

### 截图诊断与语义修正

用户截图显示 `2026/11/16 23:39` 的上下文注入、一次 `send_text · kook` 工具调用，随后又有 `2026/11/16 23:40` 的上下文注入。两者不是同一模型请求里同时可见的两条时钟，而是同一轮的两个模型步骤各注入了一次。空 surface replacement 虽然保证后续请求只有一条可见时钟，但界面仍保留两次注入事件，不符合“每轮只注入一次”的要求。

`current-time.ts` 因而记录本次已经成功附加时钟的 `turn`。同一轮后续 `agent/pre-step` 直接复用已注入的快照，不再清理旧时钟、追加空 replacement 或生成新时间；只有新 `turn` 的第一次实际步骤才采样并替换旧快照。挂载和卸载时的历史清理规则不变。

定向回归仍为 3 个文件、30/30 项通过。更新后的用例明确验证：同一轮第 2 步返回的新增时钟数为 0，耐久日志没有新增时钟或空 replacement，可见时间保持第 1 步读数；跨午夜后的新 turn 才更新读数。真实部署验收使用一次本地 `read` 工具调用制造后续模型步骤，不以无工具的单步请求代替该场景。

### 部署与真实验收

等待已有主意识回复自然结束，确认 `running=false` 且 LiveKit `activeCallRooms=0` 后执行受控重载。真实 Web 自检 requestId=`2026-11-16T16-19-39-780Z-2d42c051`，本轮明确调用一次本地 `read`，最终请求记录为 step 2。整轮正文非空的新增时钟事件只有 1 条，来源为 `elysia-calendar-context`，文本为 `2026/11/17 00:18`；最终模型请求中的可见时钟也只有这一条。工具事件仅为 `read` 的 call/result，回复为“每轮单次时间检查完成”，没有调用任何外部渠道工具。

验收后主意识与语音插件保持 enabled/active，主 Agent `agentAvailable=true`、`running=false`，LiveKit `activeCallRooms=0`、`occupied=false`。
