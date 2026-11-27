# @elysia/villv-helix

> 状态：当前启用。本文是工具面插件的正式文档；包级快速说明见
> [`plugins/villv-helix/README.md`](../../plugins/villv-helix/README.md)。

## 1. 身份

| 项 | 值 |
|---|---|
| 显示名 | Elysia/VillV-Helix（维尔薇 · 螺旋） |
| 包名 | `@elysia/villv-helix` |
| 插件 id | `villv-helix` |
| 目录 | `plugins/villv-helix/` |
| Host + Web | 是 |
| 管理插件 | 无 |
| standalone | 否 |

## 2. 职责

- 读取当前 Agent 的真实工具定义；
- 安装会话级 `tools.restrict()` 全局工具 deny mask；
- 锁定官方预设静态工具；
- 对自定义预设静态工具做 `tools/pre-execute` 门禁；
- 为会话挂载扩展工具套件；
- 保持未启用工具仍在 schema 中；
- 提供 `工具`、`预设` 两个原生 Conversation view；
- 提供工具编辑模式胶囊；
- 持久化会话工具面、编排状态和工具组预设。

## 3. 非职责

- 不注册 `send_text`、`send_voice`、`session_*` 等业务工具；
- 不管理上下文事件订阅、队列和注入日志；
- 不管理预设创建；
- 不创建或切换 Session；
- 不提供健康页或 `status` 接口；
- 不提供独立运行模式，也没有 manage 开关。

## 4. 工具语义

```text
官方预设静态工具
  origin: static
  locked: true
  setTool => TOOL_STATIC_LOCKED

自定义预设静态工具
  不重复注册同名工具
  tools/pre-execute 按 session enabled set 放行
  关闭时 schema 仍在，执行 => UNKNOWN_TOOL
  与特殊工具同名时仍可切换，不进入锁定卡

Helix 挂载的扩展工具
  稳定声明
  未启用 => UNKNOWN_TOOL
```

`tools.restrict()` 只处理全局工具，不能撤销预设/Agent scope 的注册。自定义预设静态工具使用 pre-execute 门禁，而不是重复注册。

## 5. 视图

```text
工具
  全局工具按类分组
  静态工具锁定卡
  批量选择、草稿、保存
  工具组预设

预设
  当前预设静态工具
  当前会话 system prompt
  提示词文件预览
```

工具编辑模式关闭时，这两项由 Client 标记并隐藏；Context Gate 的事件/日志视图不属于本插件。

## 6. 状态

```text
stateDir = dshHomePath('villv-helix')
file     = villv-helix-state.json
```

文档包含：

```text
sessions:
  orchestrated
  enabledTools
  disabledTools
toolPresets
updatedAt
```

旧的 `contexts` / `events` / `queues` 字段读取时忽略，不迁移。

## 7. 权限与失败

- 只写自己的状态目录；
- 不读 Context Gate、预设管理器或其他插件状态；
- restriction 安装失败要显式记录；
- 面板读取的是 Host 实际快照，不伪造工具状态；
- 卸载时释放全部 restriction、监听器和 slot。

## 8. 测试

```powershell
cd plugins/villv-helix
pnpm run typecheck
pnpm test
pnpm run build
pnpm run bundle
```

测试覆盖：

- 官方静态工具锁定；
- 自定义静态工具的 enable/disable 和 schema 稳定性；
- 扩展工具的 pre-execute 门禁；
- 工具组预设；
- legacy 状态字段被忽略；
- 卸载清理；
- 工具/预设视图。

## 9. 相关文档

- [插件开发规范](../architecture/elyh-plugin-spec.zh.md)
- [工具面与控制面板](../architecture/elyh-control-panel.zh.md)
- [ElyH 扩展能力架构](../architecture.md)