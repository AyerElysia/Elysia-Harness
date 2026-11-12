# Voice-call 占位与需求交付记录

日期：2026-11-12（Asia/Shanghai）。
范围：Spark 原仓 /home/ayerelysia/Elysia/Elysium/Elysia-Harness。
任务：用户仅授权建立占位和需求文档，不实施全双工通话。

## 交付

- plugins/voice-call/package.json：预留 @elysia/voice-call 独立包。
- plugins/voice-call/tsconfig.json、cordis.patch.yml：沿用仓库插件结构，但不接入任何运行 profile。
- plugins/voice-call/src/index.ts：仅 name 与空 apply，导入/挂载无业务动作。
- plugins/voice-call/tests/placeholder.spec.ts：元数据、无行为入口及 Cordis 挂载/卸载/再次挂载。
- plugins/voice-call/README.md：真实状态与可复现的轻量测试方式。
- plugins/voice-call/REQUIREMENTS.zh.md：需求讨论稿，区分确认事项、工程要求、建议与待定项。

需求覆盖双向音频、插话/播放截断、回声、会话归属、工具权限、真实播放与使用量证据、隐私/授权、长通话、退出清理和验收。以官方 gpt-realtime-2.1-mini 为初始目标，未验证账号模型权限。语音意识与文字主意识关系、最终音色、首发入口仍待用户决定；不自动替换现有 Breeze 固定参考音频。

## 验证

- 直接使用现有 dsh/node_modules/.bin/vitest 运行本插件测试：1 个文件，3 项通过。
- 使用现有 tsc --project plugins/voice-call/tsconfig.json --noEmit，增量缓存写入专属 /tmp 目录：通过。
- 第二次过滤运行测试同样 3 项通过；其附带安装行为见下方说明。
- 独立只读审查覆盖全部 7 个插件文件：未发现阻断项。
- 检查 Web/TUI homes 下无 @elysia/voice-call 挂载引用。
- 不执行全仓构建、真实模型/通话/音频测试；这些均不在占位验收范围。

## 运行与数据边界

未改主体文件、提示词、原生主 Session、现有模型路由或参考音频；未启动、停止或重启任何服务。未读取或保存真实密钥、配置凭据、发起模型请求、采集/播放音频。无提交或推送。

## 依赖锁文件注意事项

验证 README 初稿中的 pnpm --filter 命令时，pnpm 意外自动解析了整个工作区、安装 1 项依赖，并运行已有 lefthook 安装脚本。后续已改用直接调用现有 Vitest，不再重复触发安装。

dsh/pnpm-lock.yaml 在本任务开始前已是未提交修改，且没有内容级基线。已精准撤去本轮可确认新增的 ../plugins/voice-call importer；不把 HEAD 当作基线覆盖其他更改。当前其余差异包含其他任务依赖条目以及包管理器可能归一化的格式、peer 解析条目，无法可靠逐项归属，保留并明确记录此不确定性，需在集中整理依赖锁时复核。不能据此声称整个锁文件与开工时逐字一致。

仓库其他未提交文件不属于本任务，未主动修改或回退。
