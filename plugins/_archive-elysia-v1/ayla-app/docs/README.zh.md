# Ayla-use 架构图

两页 HTML 是**可编辑的源**，PNG 由它截图得到。改图改 HTML，不要改 PNG。

| 文件 | 内容 |
|---|---|
| [tools-map.png](./tools-map.png) | 工具全景：本期 **20 个 / 8 类** + 4 个「依赖未就位不注册」 |
| [architecture.png](./architecture.png) | 运行时架构：主意识层 → 注册器 → 插件 → **入站覆盖** → REST → 能力边界 |
| `tools-map.html` / `architecture.html` | 上面两张图的源（纯 HTML + CSS，无依赖） |

## 图上表达的四件事

1. **工具只注册到主意识层**，不做全局注册；elyh 与 standalone 是二选一，standalone 多一个
   `ayla-channel` 收件箱。
2. **发窄收宽**：本期发出的只有文字 / 分享 / 戳一戳；但收到的必须覆盖全部 10 种消息类型。
   收是通道的事，发才是工具的事——两条链路分开画。
3. **入站现在缺口很大**：`SUPPORTED_PART_TYPES` 只有 `{text, image}`，其余被标 failed，
   poke/system 根本不入队。这条需求**必须改后端**。
4. **能力边界写在图上**：直播 `:start` 只改标记（无推流 → 黑屏）、语音 `join` 只落成员表
   （无 LiveKit → 不能出声）。两条都要求工具如实返回，不许假装发生。

## 重新生成

需要本地静态服务（Playwright 禁止 `file:` 协议）：

```powershell
python -m http.server 8791 --bind 127.0.0.1 --directory plugins/ayla-app/docs
```

然后对每页截图（Playwright MCP）：

```text
browser_navigate  http://127.0.0.1:8791/tools-map.html
browser_resize    1360x900
browser_take_screenshot  fullPage=true, filename=tools-map.png
```

截图默认落在仓库根目录，记得搬进 `docs/` 并删掉根目录的那份。

字号与间距依赖 1360px 固定宽度；改宽度会改变换行位置，需要重新看一遍图。

## 配色约定

| 色 | 含义 |
|---|---|
| 蓝 `#6d9ce8` | 读（GET） |
| 黄 `#d9a441` | 写（含不可逆动作的容器工具） |
| 红 `#d0453a` | 不可逆（撤回） |
| 灰 `#d9d3d6` | 本期不注册 |

底 `#fbfafc`、强调 `#b8738f`，与 Ayla 前端「千禧冰樱」同族，但正文以可读性优先。
