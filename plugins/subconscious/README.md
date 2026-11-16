# Subconscious

爱莉的潜意识中枢与多专业 session 宿主。目标是让进入主意识的外部信息、主意识输出与外部结果先形成完整、可追溯的表界观察，由长期 Router 统一研判和派发，再由记忆、学习、技能验证、计划等独立专业 session 执行；主动表达候选交给主动系统和主意识决定，而不是由潜意识直接外发。

当前仅为无行为占位：没有 Router 或专业 session、表界采集、任务派发、心跳、休息状态、模型调用、日记写入或模型工具，也没有加入当前 Web profile。

- 共用宿主、提示词、心跳、休息与唤醒需求：[REQUIREMENTS.zh.md](REQUIREMENTS.zh.md)
- 第一个记忆 session 的日记与笔记需求：[sessions/memory/REQUIREMENTS.zh.md](sessions/memory/REQUIREMENTS.zh.md)

从 `dsh` 工作区运行占位生命周期测试：

```sh
pnpm --filter @elysia/subconscious test
```

该测试只验证无行为插件可以挂载和卸载，不验证任何尚未实施的潜意识能力。
