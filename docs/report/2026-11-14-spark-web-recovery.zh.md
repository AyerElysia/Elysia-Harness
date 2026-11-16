# Spark 重启后的 ElyHarn 恢复（2026-11-14）

## 时间线

- 北京时间 11:02，Spark 完成一次启动。11:12 启动了正常的 systemd 重启流程，现役内核在 11:20 启动。证据来自 `last -x` 与 `journalctl --list-boots`。这些日志可以确认重启，尚未定位第一次离线的触发原因。
- SSH 恢复后，Web、舞台、Breeze 和语音试用原有监听均为空。ElyHarn 的 `master` 与此前已推送的 `978aeb5d80` 一致。Spark 工作区已经切换到一批尚未提交的 DSH `0.2.2-rc.2` 源文件，原 Web 启动器仍优先选 Node 22。
- 隔离 Web 启动暴露出前端构建缺失和 Web profile 内部的失效依赖链接。正式 Web 启动后，主意识恢复还需要 `linux-arm64/bin/glibc/system.node`。没有改写原会话内容，也没有回退那批 DSH 文件。
- Windows 桌面脚本能建立 SSH 转发，但登录仍返回 401。旧日志包含空字节，`grep -o` 漏掉当次启动末尾的新链接。将两处匹配改成 `grep -ao` 后，桌面脚本用当次链接得到登录重定向及已认证页面 HTTP 200。

## 操作和验证

- 按 Node 官方发布清单校验 ARM64 v24.11.1 归档并安装至用户目录。Web 启动器优先使用 `~/.local/share/node-v24/bin`，保留旧运行时的启动路径作为备用。
- 重建 DSH 客户端包、Web 界面和 Linux ARM64 本机扩展。用空白 home、回环临时端口、禁用外部通道的 profile 验证 Web 认证、空会话列表，以及舞台试听、声音和字幕路由。
- 将正式 Web profile 的 `conscious-mind`、`request-archive`、`context-inspector`、`ayla-app`、`kook-bot`、`qq-napcat`、`feishu-app` 安装副本换成指向项目插件目录的链接。原安装副本保存在 `homes/web/session-backups/web-profile-before-recovery-irw7arfk/`。启动前的会话和 storage 快照保存在 `homes/web/session-backups/web-pre-recovery-20261114-1ylrkeev/`。
- 正式 Web 监听 3299、3300 和 18793。会话列表保有 18 条记录，主意识在线。主意识和直播两处的原生会话投影显示下一次请求为 `nexus-a6-gemini / gemini-3.8-flash`。直播间为空闲，Windows 经 SSH 转发访问试听、声音与字幕均返回 HTTP 200。
- 手动恢复原 Breeze 容器与 LiveKit 试用、Gemini worker、broker、ASR。ASR 三个模型文件按项目清单校验，Python 依赖按锁文件恢复。7 个语音健康端点返回 HTTP 200，LiveKit 无活动房间。没有触发真实麦克风通话、B 站推流或额外模型请求。

需要恢复原插件安装时，先停下本次启动且已核对所有权的 Web 实例，再从上述安装备份逐项还原对应名称。会话备份用于对照和人工恢复，勿用它覆盖恢复后新增的会话历史。下一次有计划停机时可从系统或管理控制台补查首次断连原因。
