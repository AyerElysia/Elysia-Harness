# @elysia/mobius-infinity

> 状态：当前启用。本文是预设管理插件的正式文档；包级说明见
> [`plugins/mobius-infinity/README.md`](../../plugins/mobius-infinity/README.md)。

## 1. 身份

| 项 | 值 |
|---|---|
| 显示名 | Elysia/Mobius-Infinity（梅比乌斯 · 无限） |
| 包名 | `@elysia/mobius-infinity` |
| 插件 id | `mobius-infinity` |
| 目录 | `plugins/mobius-infinity/` |
| Host + Web | 是 |
| 管理插件 | 无 |
| standalone | 否 |

## 2. 职责

- 管理 Agent preset 元数据；
- 管理提示词文件（SOUL / USER / MEMORY 等）；
- 管理预设工具组、固定 compaction 组；
- 创建/编辑/删除预设；
- 提供预设创建页面；
- 注册 `preset_list`、`preset_create` 工具。

## 3. 非职责

- 不创建或切换 Session；
- 不管理当前会话工具开关（VillV-Helix）；
- 不注册业务工具；
- 不管理上下文事件；
- 不提供全局注入开关；
- 没有 standalone / manage 开关。

## 4. 预设结构

```text
identity
prompt-files
time-context
tools（聊天面可选）
compaction
```

`tools` 组只保存工具 id；空工具集省略。compaction 组固定为 basic + compact + pruner。

## 5. 与 Helix 的边界

```text
Mobius   负责预设定义和组合
Helix    负责当前会话的可见性、静态锁定和执行门禁
```

- 官方预设静态工具由 Helix 锁定；
- 自定义预设的同名特殊工具由 Helix 做执行门禁，可切换；
- Mobius 不维护第二套工具状态。

## 6. 状态

预设文档、提示词文件和备份位置由 profile 配置。
不把会话状态和 Context Gate 状态写进预设文档。

## 7. 权限与失败

- 预设写入必须走持久化事务；
- 不读取未授权的提示词文件；
- 删除预设前必须校验引用；
- 不把预设创建变成后台隐藏任务。

## 8. 测试

```powershell
cd plugins/mobius-infinity
pnpm run typecheck
pnpm test
pnpm run build
pnpm run bundle
```

覆盖预设解析、创建、删除、工具组、提示词文件、页面和卸载。

## 9. 相关文档

- [预设管理](../architecture/elyh-preset-manager.zh.md)
- [插件开发规范](../architecture/elyh-plugin-spec.zh.md)
- [插件文档索引](README.md)