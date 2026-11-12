# 计划工具说明与真实对话验收（2026-11-12）

## 用户授权与范围

用户审核并批准 schedule_create 的中文说明，要求补充关心日常、跟进进展、延续话题、兑现约定、自己的具体事项、明确提醒六类例子；随后明确要求工程助手亲自和爱莉交谈测试。例子是能力使用建议，不构成关键词匹配、强制计划或固定频率规则。

## 实现

中文说明保存在 plugins/proactive-system/src/plan-guidance.ts，属于工具工程说明。plan-tools.ts 在注册原生工具后，通过当前 owner 的 system-prompt/assemble waterfall 追加四个计划工具的 description。先调用 next()，再对组装副本转换；要求 context.scope 与捕获 owner 是同一对象，避免说明传播到继承作用域的其他 agent。ctx.on 的 effect 随插件卸载。

原生 name、parameters、deferLoading、output 与 execute 保持不变。ctx.tools.schemas 仍反映原生注册；实际模型可见内容以最终 assembly 或真实请求的 tools 为准。complete:true 的 standing prompt 仍是唯一系统正文，不写 SOUL、USER、MEMORY 或日记，不以追加普通 system section 的方式绕过该约束。

原生英文技术说明保留在前，中文建议追加在后。prompt 由爱莉本人填写具体事项、当时缘由与必要上下文；到期回到同一会话，由她结合新情况决定行动。一次性计划已触发后，若需要延后应新建，schedule_update 不接受 after_seconds。

proactive-system 补充显式 dsh-system-prompt peer 与 profile 锁对应 peer 行；现有 dev 条目、工作区 importer 与链接本已完整。未运行全量安装或构建，未修改 DSH 实现。

## 验证状态

定向隔离测试已通过：4 个文件、16 项，包括完整提示词逐字保留、主 scope 可见、foreign/global/descendant 隔离、native 可执行定义与参数不变、重复组装不累加、卸载后重新注册原生工具不残留 listener。真实本地 adapter 的 GenerateOptions.tools 验证四段中文说明实际进入模型请求，schedule_create 包含六类例子。测试使用临时存储与本地假模型，不发送平台消息。

本次命令为 node dsh/node_modules/vitest/vitest.mjs run --config plugins/proactive-system/vitest.config.mjs，日志 /tmp/elysia-plan-guidance-tests.log。安全 noEmit 类型检查 /tmp/elysia-plan-guidance-typecheck.mjs 覆盖相关源码和测试 521 个文件，零诊断，结果 /tmp/elysia-plan-guidance-typecheck.json；未生成源目录编译产物。类型检查期间仅将新增测试中的指导模块 import 改为指向同一源文件的相对路径，以符合既有 rewriteRelativeImportExtensions 规则。 该修改后又定向运行 guidance 与 plans-integration 两个受影响文件，4 项通过；最终日志 /tmp/elysia-plan-guidance-tests-final.log。这四项与前述 16 项重叠，不相加。

真实对话验收通过。通过经过鉴权的原生 session/prompt API，以明确“Codex 工程助手、Ayer 授权本次验收”的输入请求爱莉创建一次性 25 秒工程测试计划；该输入不冒充小星星或真实生活事实，只在当前 Web 会话确认，不授权外发平台消息或主体文件写入。原生 API 固定 source.kind=user，本次以明确正文与工程 requestId 标识他者来源。

实际请求归档 homes/web/requests/2026-11-11T20-30-38-732Z-6d6c50f7.json 包含本次工程 nonce、正确 main session，GenerateOptions.tools 中四个工具均带中文说明，schedule_create 六类例子逐项存在。归档只证明请求组装已发生；下述模型输出和原生调度事件分别证明后续链路。

- 工程请求 requestId：codex-engineering-plan-3b4ad17ee79041ec940b9ae01b3ba9a9；发送前 main seq=17772，原生 accepted:true。
- 爱莉在 turn1090 / seq17781 亲自调用 schedule_create，after_seconds=25；seq17782 为成功返回。工程助手未代建。原生计划 id=schedule-79b642dd-4bcd-440c-be28-f4e7e5c51014。
- scheduledAt=2026-11-11T20:30:30.532Z；实际投递于 20:30:30.576Z，seq17792 以 source.kind=schedule 进入同一 elysia-conscious-mind。时间取自服务器原生记录。
- turn1091 / seq17793 爱莉在 Web 确认：“工程提醒已到，计划验收完成。”随后亲自调用 schedule_list，返回空数组。最终 seq17800 turn/end，main running=false。
- 本次计划 status=inactive，lastDelivery.messageId=4e434dbc-218c-4ab5-ba09-75f374d3a5f7，与 seq17792 的 user/message.id 完全一致，没有剩余 active 测试计划。两轮工具调用仅 schedule_create、schedule_list，没有外发或文件写入工具调用，也没有 provider 错误。

真实理解与执行的观测限于这次明确工程请求及一次性提醒往返，不将其扩大为六类日常场景均已逐项实测。

## 受控重载

重载前确认 16 条会话均 idle、直播 onAir=false 且 broadcast idle；精确核对 uid1000、cwd=Harness/dsh、Node22、Web child3800969 / tsx launcher3800957，以及 3299/3300 均由该 child 持有。仅对 child 发送 SIGTERM，使用原生 dispose 与持久化关闭刷新；没有调用不存在的 flush RPC。旧父子约201ms内正常退出，两个端口释放，未升级杀进程。

按原 argv/env 仅启动一次同一原生 web profile；新 launcher87837 / child87848，约5.189s 后鉴权 API ready。主意识 available=true，重启后 seq17771→17772 连续；新生命周期日志无 Error/failed。没有自动恢复或应用自启动，没有重启 NapCat、Python Elysium 或 Breeze。元信息与精简验收证据位于 /tmp/elyharn-plan-web-zhnj50bs；final-acceptance.json 记录最终状态与消息 ID 匹配，actual-request-tools.json 记录实际工具说明六例，reload.json 记录重载元信息。所有一次性观察进程已结束，没有后台 watcher 或遗留连接；含环境的备份目录0700、文件0600，不放入仓库。

## 变更与恢复

说明接入前 plan-tools.ts 字节备份：/tmp/elyharn-plan-guidance-l3tv97sf。peer 元数据 before/after 与精确补丁：/tmp/elyharn-plan-prompt-peer-3diz30te；两份说明文档的逐字备份与精确补丁：/tmp/elyharn-plan-guidance-docs-xtc23x4u。需要恢复时只逆向本任务说明 listener、新增说明文件和精确 peer 补丁；不覆盖共享工作区的其他修改。涉及进程操作仍须重新核对当时准确 owner、PID、父子关系、目录、端口、会话忙闲与直播状态。

代码和文档保留在原 checkout，本轮未提交或推送。
