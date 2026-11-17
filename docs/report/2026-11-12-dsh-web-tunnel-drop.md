# 2026-11-12 dsh web 端口转发隧道"过一会就断"诊断

本记录为只读诊断结论，时间均为 Asia/Shanghai（UTC+08:00）。没有修改任何代码、脚本或远端服务；所有探针进程在诊断结束后已按端口精确定位并终止。

## 现象

Windows 侧执行下述两条命令后，本地 `127.0.0.1:3299` 的转发会在短时间内失效：

```powershell
Start-Job -ScriptBlock { ssh -N -L 3299:127.0.0.1:3299 -o ServerAliveInterval=30 -o StrictHostKeyChecking=no ayerelysia@frp.volx.top -p 6020 } | Out-Null
ssh ayerelysia@frp.volx.top -p 6020 "bash /home/ayerelysia/Elysia/Elysium/Elysia-Harness/scripts/dsh-web-start.sh"
```

## 根因

**`Start-Job` 启动的 ssh.exe 是父 PowerShell 进程的子进程；父 PowerShell 进程结束时，Windows PowerShell 的 job 机制会一并终止它。**

实测（本机 PowerShell 5.1，OpenSSH 9.9p2 / Git for Windows ssh）：

| 实测 | 起法 | 父 PS 退出时刻 | 监听消失时刻 | 结论 |
|---|---|---|---|---|
| 1 | `Start-Job`，端口 3294 | — | 父进程返回后 ~1 s | 随父进程死 |
| 2 | `Start-Job`，端口 3292 | 09:22:41 | 09:22:49（0.5 s 采样：42.05–48.73 仍在，49.71 已无） | 随父进程死（回收 6–8 s） |
| 3 | `Start-Process` 分离，端口 3295 | 09:07:23 起父进程立即退出 | 09:17 仍存活（>10 min），并经隧道访问到远端 web | 与父进程无关 |
| 4 | `ssh -f` 自后台，端口 3296 | 同上 | 09:16 仍存活 | 与父进程无关 |
| 5 | `Start-Job` 且父 PS 持续存活 25 s | 父进程存活期间 | 之父进程活着时一直 LISTENING | 证明依附关系 |

因此「过了一会就断」= 那个持有 job 的 PowerShell 会话结束（关窗口、退出、或 `-Command` 命令跑完主机即退出）。关闭窗口与执行 `Get-Job | Stop-Job`（PSReadLine 历史中有 4 次）是同一后果。

PSReadLine 历史可佐证反复重建：`Start-Job -ScriptBlock { ssh -N -L 3299 ... }` 出现 29 次，`dsh-web-start.sh` 16 次，`Stop-Job` 4 次。

## 次要缺陷：端口被占时 ssh 会"假活着"

命令行未带 `-o ExitOnForwardFailure=yes`。实测：当本地 3299 已被上一条 ssh 占用时，新起的 ssh **不退出**，只在 stderr 反复输出：

```
bind [127.0.0.1]:3295: Address already in use
channel_setup_fwd_listener_tcpip: cannot listen to port: 3295
Could not request local forwarding.
```

进程仍在、`Start-Job` 仍显示 running，但本地转发并未建立。表现就是「隧道看起来在跑，页面打不开」。加上 `ExitOnForwardFailure=yes` 后会立即失败退出，可被脚本捕获。

## 已排除的可能原因

| 怀疑项 | 证据 | 结论 |
|---|---|---|
| frp 服务端链路断 | `/home/ayerelysia/frp/frpc.log` 中 `try to connect to server` 在 2026-11-05 之后无新记录；frpc 进程已连续运行 2 天 21 小时 | 非原因 |
| 远端 dsh web 崩溃/重启 | `ss -tlnp` 显示 3299 由 node pid 556889 持有，进程自 06:27:01 起持续存活 2h40m+；`elyharn-web.log` 中 FATAL/uncaught/heap OOM 计数为 0；远端可用内存 97 GiB | 非原因 |
| 服务端内存 / OOM | 同上；`free -h` 显示 swap 仅用 24 KiB | 非原因 |
| Clash/mihomo 代理中断 | mihomo 日志：`frp.volx.top:6020 match GeoIP(cn) using DIRECT`；fake-ip `198.18.0.88` 与真实 `47.108.85.223` 均可连通；5 分钟长连探测无中断；今日仅 2 次 TUN 接口切换（08:36:39 → Radmin VPN，08:36:44 → WLAN） | 非原因 |
| Wi-Fi 切换 | 今日 WLAN 事件：08:36:36 断开 → iQOO 11，08:47:39 断开 → 千兆科技_5G；探针跨过这两个时刻仍存活 | 非原因 |
| 系统睡眠 | 最近一次睡眠 2026-11-12 00:35:06，唤醒 00:35:09；此后无 42/107 事件 | 非原因 |
| `-p 6020` 写在 hostname 之后导致端口失效 | `ssh -G frp.volx.top -p 6020` 与 `ssh -G -p 6020 frp.volx.top` 均解析为 `port 6020` | 非原因 |
| 服务端 `ClientAliveInterval` 回收 | `/etc/ssh/sshd_config` 中该项为注释（默认 0），`TCPKeepAlive yes` | 非原因 |

## 附带发现（不影响本次现象，但应知道）

1. **服务端不回收被强杀的会话**：`sshd` pid 96778 / 119756（04:31:07、04:38:52 建立）在客户端已被杀 4 小时后仍在，无子进程（符合 `ssh -N`）。默认配置下客户端异常退出不会让服务端立刻关闭会话。多次重建隧道会在远端堆积孤儿会话。
2. **服务端日志中 `sshd[97001]: error: connect_to 127.0.0.1 port 3299: failed.` 出现在 04:58–06:27**：这是"隧道在、转发目标暂不存在"的另一类故障（当时远端 web 未运行），与本次「隧道本身消失」不同，排查时需区分。
3. **远端 cron 中两条 guard 已失效**：`elyharn_guard.sh`、`elysium_guard.sh` 在远端均不存在，手动执行返回 127；但 `elyharn_guard.log` 最后一条是 2026-11-11 18:14。即远端 web 目前**没有**自动恢复兜底。

## 修复方式

### 一次性正确起法（与父进程无关）

```powershell
Start-Process -FilePath "$env:SystemRoot\System32\OpenSSH\ssh.exe" -WindowStyle Hidden -ArgumentList @(
  '-N',
  '-o','ServerAliveInterval=30',
  '-o','ServerAliveCountMax=3',
  '-o','ExitOnForwardFailure=yes',
  '-o','StrictHostKeyChecking=no',
  '-L','3299:127.0.0.1:3299',
  '-p','6020','ayerelysia@frp.volx.top'
)
```

或用 ssh 自身后台：

```powershell
ssh -f -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 ayerelysia -L 3299:127.0.0.1:3299
```

（`~/.ssh/config` 已有 `Host ayerelysia` 别名，可省略 host/user/port。）

### 停止

按端口精确定位，避免误杀其它 ssh：

```powershell
Get-NetTCPConnection -LocalPort 3299 -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique |
  ForEach-Object { Stop-Process -Id $_ -Force }
```

## 本次诊断的探针与清理

- 使用的临时端口：3290、3292、3293、3294、3295、3296、3297、3298、3399（均在 127.0.0.1，未触碰 3299）。
- 探针进程终止方式：按端口查 OwningProcess 后 `Stop-Process -Force`；结束状态确认「329x 段无监听」。
- 未操作远端任何进程、服务或数据；远端只做只读查询（`ps`、`ss`、日志读取、`crontab -l`）。
