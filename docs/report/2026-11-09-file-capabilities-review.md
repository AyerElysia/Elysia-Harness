# 2026-11-09 文件能力提交前审查

审查起点为 Elysia-Harness 0b0a237698，原未提交内容的工程快照在本机私有
/tmp/elysium-commit-review-20261109-6az6yno_/harness。
本次仅修改工程源码、测试、依赖元数据和文档，不读取或改写真实主体提示词、工作区资料、会话或历史。

## 功能与修复

新增 agent-scope 文件能力模块，复用 DSH 原生 read/write/edit/glob/grep 与 read_image。
主意识与 elysia preset 使用同一套工作区、单文件提示词白名单和备份配置；
主体正文只能经其授权工具行动链改变，开发代理不代写。

提交前审查用隔离回归复现并修复：
- 对完整搜索值做路径复核，不能只检查被预算截断的 metadata。
- 搜索结果拒绝可检测硬链接，避免 grep 返回 read 已拒绝的越界内容。
- 字面编辑、美元符号替换和 CRLF 归一化采用与实际执行一致的大小计算。
- 省略搜索 path 时检查实际工作目录，保持默认根在已准入工作区。
- native 文件/搜索子插件和后续装配失败均有完整清理，正常卸载不残留工具。
- 文件与搜索原生工具改为仅在目标 agent scope 注册，撤销新增 host 全局启用；
  standard 维持其原生只读策略，minimal 不获得新能力。

未修改 vendored DSH 源码。dsh/pnpm-lock.yaml 仅纳入此插件需要的 importer 变化；
工作区原有两处 Node 类型版本漂移保留在未暂存差异中。
Web profile 仅纳入可复现插件装配，本机 UI notice、临时公网隧道行保留在工作区。
固定 cwd 的 Data 符号链接与提示词备份目录被忽略，目录内容不进入 Git。

## 验证

- 最终正常 Vitest 配置：conscious-mind 10 文件、57 用例通过。
- conscious-mind、KOOK、QQ、飞书、request-archive 五插件 TypeScript 无输出检查零诊断。
- pnpm install --filter @elysia/conscious-mind --offline --ignore-scripts --frozen-lockfile 成功，
  锁文件策略校验通过；仅开发工作区依赖链接，未安装 Web profile 运行副本。
- 配置 YAML、包 exports、peer/importer 元数据及精确暂存内容由主代理另行核对。
- cwd 沙箱测试必须在 checkout 内自有唯一临时夹具中运行，因为系统 /tmp 是 DSH 既有可写根；
  夹具已清理，没有接触正式 Data 或竞争正式端口/storage authority。

首次五项边界回归确实复现失败，修复后通过；后续新增 scope 隔离与失败清理回归亦通过。
这些结果属于当前源码，不以既有部署的测试数量或运行日志替代。

## 部署与回滚边界

本次只作本地提交，不推送、不重启、不发送模型或平台消息。
由于 file: 依赖存在 Web profile 安装副本，源码与依赖链接更新不等于运行副本已更新。
后续部署必须核对安装副本哈希、真实启动与长期 session 恢复，再按风险验证文件工具。
本次没有耐久状态迁移；撤销工程提交即可撤销源码变更，不能用删除 session 或恢复主体正文代替代码回滚。

第四阶段是工程计划，单独提交；它不授权开发代理根据用户审批改写主体语义。
