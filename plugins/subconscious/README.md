# Subconscious

爱莉的多潜意识 session 宿主。目标是用独立的长期 session、固定提示词组合、来源游标和工具权限，分别承载记忆、学习及以后的潜意识任务，而不是让一次心跳处理所有工作。

当前仅为无行为占位：没有 session、心跳、休息状态、模型调用、事件订阅、日记写入或模型工具，也没有加入当前 Web profile。

- 共用宿主、提示词、心跳、休息与唤醒需求：[REQUIREMENTS.zh.md](REQUIREMENTS.zh.md)
- 第一个记忆 session 的日记与笔记需求：[sessions/memory/REQUIREMENTS.zh.md](sessions/memory/REQUIREMENTS.zh.md)

从 `dsh` 工作区运行占位生命周期测试：

```sh
pnpm --filter @elysia/subconscious test
```

该测试只验证无行为插件可以挂载和卸载，不验证任何尚未实施的潜意识能力。
