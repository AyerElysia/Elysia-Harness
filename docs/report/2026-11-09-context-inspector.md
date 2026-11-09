# 2026-11-09 DSH 上下文查看器接入

用户确认只需最近实际调用，不需要下一轮预览。新插件 @elysia/context-inspector
在 Web 会话顶部提供“上下文”，读取所选 session 的实际适配器前归档。
原生“轨迹”的历史系统行不能替代该查看器；归档也不能冒充最终 HTTP 抓包或成功送达证明。

## 变更及权限

只新增独立插件、request-archive 的派生索引通知、Web 挂载与锁元数据、工程文档。
接口沿原生 Gateway/Remote/session resource 授权；不增无鉴权 HTTP 通道。
未编辑主体提示词、日记、私有历史或原始归档。共享工作区既有主意识/KOOK/脚本修改保持原样，
接入验收时未暂存、提交或推送本次及并行代码；后续代码整理另行记录。

系统视图含独立 system 与全部 system/developer 消息，完整后可读原文或 JSON。
其余视图保留全部消息、工具定义和原始 JSON。每页至多 64 KiB，明确部分/完整，
固定 request ID，取消、刷新、切会话与卸载丢弃迟到响应。

## 部署证据与更正

只补 request-archive/src/index-store.ts 运行目录硬链接与新插件目录链接，
核对新增源文件 SHA/inode 与 client 构建产物，没有运行全 profile 安装。
确认会话 idle，核对 Web PID 1170639、父 1170601、owner ayerelysia、
cwd dsh、127.0.0.1:3299 后，对该精确 Node 一次 TERM。
以原 tsx 父入口的相同参数和环境单次启动，新 Node 1318476/父 1318464 成功监听，
会话 elysia-conscious-mind、v4 存储路径与既有登录继续可用；没有安装自动恢复机制。

后来 17:10:37 浏览器连接丢失，17:10:41 监听者被任务外新 Web 1333146/父 1333125
替换（新增 DSH_AGENTS_HOME 环境）；本任务及其子代理没有执行该次替换。
因此最初“大块读取可能超过64KiB协议限制”的猜测撤回：
原生 unary RPC 走普通 HTTP JSON，未发现该响应上限。
后续浏览器又被最小化，最终 UI 自动化因无法可靠确认当前网址而停止，
不把未完成的完整消息/原始 JSON 视觉复核写成通过。没有继续自动操作浏览器。

## 验证

- 新插件隔离测试 41 项通过（后端 12、前端 29），request-archive 10 项通过。
- Host 与 Client 定向 noEmit 各 0 diagnostics；仅本插件客户端构建成功。
- UTC 显示最终使用原始 ISO，最后 6 项 DOM 用例通过并重建 client。
- 原生 Gateway 实测 owner 访问、guest 权限拒绝、跨会话拒绝与卸载；无认证 API 返回401。
- 实际浏览器已确认“上下文”标签、55,595字节系统视图完整、9个工具定义完整；
  完整消息初始分页/错误状态可见，但最终整节视觉验收受上述中断阻断。
- 用户现存并行主意识变更在重载前只读复核，两项隔离测试共16项通过；
  未用测试数量冒充完整平台发送或模型成功验收。
- 挂载后显式对最新已知归档再 seed，四节逐页读取、消息/工具计数和原始 SHA 校验通过；
  原始文件 seed 前后逐字节哈希一致。最后原文证据仅记录身份/计数/字节，不含正文或凭据。

最新单文件核对：
{
  "metadata": {
    "requestId": "2026-11-09T09-15-19-024Z-384c8d5e",
    "sessionId": "elysia-conscious-mind",
    "recordedAt": "2026-11-09T09:15:19.025Z",
    "provider": "d1api",
    "model": "deepseek-v4.1-flash",
    "messageCount": 3490,
    "toolCount": 9,
    "loop": true,
    "sections": {
      "system": {
        "bytes": 55595
      },
      "messages": {
        "bytes": 3012292
      },
      "tools": {
        "bytes": 9816
      },
      "raw": {
        "bytes": 3360273
      }
    }
  },
  "verified": {
    "system": {
      "bytes": 55595,
      "pages": 1
    },
    "messages": {
      "bytes": 3012292,
      "pages": 46
    },
    "tools": {
      "bytes": 9816,
      "pages": 1
    },
    "raw": {
      "bytes": 3360273,
      "pages": 52
    }
  },
  "originalSha256": "b975c4d3de24bd6290e9c83dce834cfe62596f9b0724ec01a62fd26efdbe3a7e"
}

该索引可由同一权威归档重建。回滚只需卸载新查看器 bundle/entry 与新插件安装链接；
已有 JSON 归档、主体文件和会话历史不参与回滚。已有派生 index 可以保留给后续重新挂载。
运行取证元数据位于 /tmp/elyharn-context-inspector-deploy.json，
锁修改前完整备份 /tmp/elyharn-context-inspector-locks-hvfx34ht。
