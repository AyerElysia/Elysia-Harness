# 2026-11-01 ElyHarn 未提交代码审查与整理

## 范围与证据

在 Spark 的 Elysium/Elysia-Harness 原仓库整理，起点为 914db933d39bc35a4c302c4e76e9b6dbc36c6f36。
证据来自本次工作区差异、对应源码与配置、插件测试和 TypeScript 无输出检查。
主体文件只读，既有主 session id、cwd、header 与历史均未迁移或改写。

整理顺序：

1. 审查未提交的 scoped standing prompt、Web preset 与统一文件投递需求。
2. 统一文件投递设计单独提交为 d2f7a7cfc7；send_file、OutboundFile 和渠道注册仍未实现。
3. 补齐主会话 live 借用保护与旧 QQ 实验入口兼容，核对配置与文档后提交功能改动。

## 发现与处理

原全局 complete prompt 会影响其他 agent/session。本次提取为仅能挂载在 agent scope 的 standing-prompts 子插件；
主运行层在 create/resume setup 中挂载，Web profile 当前只配置 elysia 一个 preset。
文件名单和配置在装配时固定，正文在 assemble 时重新读取，必需文件异常明确失败。

移除全局前缀后，直接借用已存在的 live 主 agent 会绕过新 setup，缺少提示词与工具隔离。
现在仅借用具有完整且配置匹配的进程内装配凭据的实例；不兼容时拒绝 followup，pending 保留。
重复同配置装配复用 promise，不同配置拒绝替换；失败回滚已注册资源，scope 卸载时清理凭据。
空 baseDir 在绝对路径归一化前拒绝，避免将空目录静默解释成进程 cwd。

旧 QQ standalone bridge 改为显式读取既定提示词名单，避免继续依赖已移除的全局前缀。
同步包导出、dsh-scope peer/reference、Web profile lock 元数据、README 与架构说明。
未修改 vendored DSH 源码。

## 验证结果

- 初轮插件回归：12 个测试文件，59 项通过；覆盖 conscious-mind、KOOK、QQ、飞书及归档相关功能。
- 最终修改后定向回归：standing-prompt 9 项、main-session 11 项、tool-registration 1 项，共 21 项通过。
  两轮结果分别记录，不将它们相加宣称为一次完整回归。
- 五个插件的初轮 TypeScript 无输出检查均为零 diagnostics；最终 conscious-mind 与 qq-napcat 复查亦为零。
- Web preset YAML、局部包导出目标、peer 依赖及两份相关 lock 元数据一致性检查通过。
- git diff --check 通过；每次提交前另核对暂存文件名单及暂存差异空白检查。
- 测试使用 mock 与临时数据；QQ 测试端口结束后无遗留监听。本次未调用真实平台或模型，也未重启服务。

## 保留项与验收边界

本机 UI notice/tunnel 设置、启动脚本的本机路径修改、DSH 生成文件与未跟踪的 guard 脚本保留在工作区，
不进入本次提交；未安装自动重启机制。父仓库既有 Python 修改、Ayla 状态和其他临时文件均不纳入提交。

本次仅作本地提交。真实启动、平台关键链路和 preset 重启恢复尚未验收，按父目录 AGENTS.md 要求验收前不得推送。
旧的宽泛 resume 异常后尝试同 id create 行为仍存在，需后续区分缺失会话与其他恢复失败；
本次没有通过删除或重建主 session 绕开此问题。

以上实现与配置变更可按提交逆向撤销；本次没有迁移耐久状态或执行外部发送。
后续开发任务负责真实启动验收及上述剩余恢复语义，不把源码或 mock 测试通过等同于真实链路验收。
