# 2026-11-13 本机 Windows 跑 ElyH web 面（接管远端已推送的全部插件）

本记录时间均为 Asia/Shanghai。目标：在 Windows 本机把 `homes/web` 这个 web 面跑起来，
且远端已推送的插件（含昨夜新增的 voice-call / gemini-cascade / memory / proactive-system）
全部按仓库现状挂载。3299 是本机到 Spark 的 SSH 隧道，**本机实例不用 3299**。

## 结论

- 本机 web 面：`http://127.0.0.1:3400/?token=…`，直播舞台：`127.0.0.1:3402`，
  两者同进程；3299 隧道旁的远端实例不受影响。
- 当天仓库快进到 `978aeb5d80`；2026-11-16 又跟着远端快进到
  `af3b94ca5e feat(plugins): add skill capabilities, desktop tools, and realtime review`。
  下面的结论在 `978aeb5d80` 上验证；`af3b94ca5e` 之后的差异见文末「后续变化」。
- 实测一轮真实对话（d1api / deepseek-v4.1-flash）返回正常，UI 面板「插件 / 直播 / Ayla /
  自动化任务」与「爱莉通话」入口齐备。

## 本机与 Spark 的差异，以及各处的处理

| 差异 | 处理 |
|---|---|
| 插件源码里写死 `/home/ayerelysia/...`（standing prompts、主意识 workspace、直播会话 cwd、Breeze 配置） | 用 junction 把该前缀映射到真实位置：`/home/ayerelysia/Elysia/Data/standing-prompts` → `homes/web/standing-prompts`、`.../Elysium/Elysia-Harness` → 仓库根、`.../Elysium/config` → `../config`、`.../Data/workspace` → 空目录。Windows 上 `/home/...` 落在 `E:\home\...`。脚本：`tmp/local-web/setup-shim.ps1`（幂等，只建 junction）。 |
| standing prompts 属于本人内容、不进 Git | 从 Spark 只读同步 6 个文件到 `homes/web/standing-prompts`（该目录被 .gitignore 覆盖）。 |
| 直播舞台默认 3300，与远端实例的转发冲突 | 本机覆盖层把 `stagePort` 改到 3402。 |
| `gemini-cascade` 在 `apply()` 里用 POSIX 属主校验 bridge key（`file.uid !== process.getuid?.()`） | Windows 上 `lstat` 恒为 mode 0666 / uid 0、`getuid` 为 undefined，必然抛 `invalid_bridge_key`。改为「无 `process.getuid` 的平台上跳过属主校验」，其余校验（普通文件、大小 ≤129、64 位 hex）保留。改动 5 行，见下。 |
| bridge key 只在 Spark 上 | 复制到 `E:\home\ayerelysia\Elysia\DataInfra\voice-cascade\bridge.key`（本机用户目录，不进仓库）。没有 18794 broker 时通话仍会 502，这属于服务侧缺失，不影响挂载。 |
| 渠道（KOOK / QQ / 飞书）只应有一个实例持有 socket | 本机启动脚本不设 `ELYSIA_KOOK_CONFIG` / `ELYSIA_NAPCAT_CONFIG` / `ELYSIA_FEISHU_CONFIG`，并置 `ELYSIA_KOOK_LISTEN=0`；三行因此 disabled，远端实例继续持有。 |
| 模型 provider 的 `D1API_API_KEY` | 复用本机桌面版凭据库 `~/.dsh/.credentials.yaml` 里的同名 key，启动脚本读取后只放进环境变量，不落文件、不打印。 |
| `homes/shared/models.patch.yml`、`homes/web/cordis.patch.yml` 是机器本地文件（被 ignore） | 与远端同源同步一份到本机，否则默认模型为空、没有 d1api。 |
| 插件 `lib/client.js`（浏览器侧模块）不在 Git 里 | 逐个 `node build.mjs` / `build-client.mjs` / `tsdown` 构建：ayla-app、context-inspector、dsh-livestream、gemini-cascade、voice-call。缺一个，对应侧栏入口就不会出现。 |
| profile 里 `file:` 依赖是拷贝而不是链接 | 新增/改动的插件必须重装 profile（`pnpm install`），否则跑的是旧拷贝——第一次启动时 `conscious-mind` 的旧拷贝没有 `./standing-prompts` 导出，直播插件直接起不来。 |

## 两处代码改动

1. `plugins/gemini-cascade/src/index.ts`：bridge key 的属主校验只在有 `process.getuid` 的平台上做。
   Linux（Spark）行为不变。
2. `.gitattributes`：给 `plugins/context-inspector/tokenizers/deepseek-v4.1-flash/tokenizer{,_config}.json`
   加 `-text`。这两个文件按 `manifest.json` 的 sha256 校验，而本机 `core.autocrlf=true`
   会把 LF 全改成 CRLF，导致 `Tokenizer asset integrity mismatch`、上下文检查器整行不挂载。
   加大属性后工作树与 blob 重新一致。

## 启动 / 停止

```sh
# 启动（先建 junction，再从仓库根启动；launcher 的 --patch 必须排在 app flag 之前）
bash tmp/local-web/start.sh

# 停止（按端口精确定位，避免误杀隧道）
netstat -ano | grep ':3400 ' | grep LISTENING
taskkill //PID <pid> //T //F
```

本机覆盖层 `tmp/local-web/local.patch.yml` 只改一处：直播 `stagePort: 3402`。
其余（主意识、上下文检查器、Ayla、请求归档、ModSearch、插件市场、gemini-cascade）全部按远端的
profile 原样挂载。

## 未验收 / 已知限制

- 本机没有 Breeze TTS 服务与 18794 broker：直播语音与 Gemini 通话的**出声**在本机不可用
  （`/api/dsh-livestream/state` 返回 `voice.available=false`）。插件挂载本身正常。
- 本机没有 `/api/…` 之外的 3300 转发，直播姬仍应继续指向远端舞台，不要改成本机。
- 真实开播、真实通话、渠道投递均未在本机执行，也不应由本机执行。

## 后续变化（2026-11-16）

- 本机快进到 `af3b94ca5e`。该提交重写了 `plugins/gemini-cascade/src/index.ts`（新增桌面工具入口
  `desktop-host.ts` / `desktop-perform.ts`），上文第 1 处改动随之被覆盖：属主校验又回到
  `file.uid !== process.getuid?.()`，且 `desktop-host.ts` 里有同样一处（`desktop_key_permissions`）。
  也就是说**在 Windows 上重启本机实例会再次抛 `invalid_bridge_key`**，要重跑本机需要重新打这个
  平台判断，或者等上游把 Windows 分支收进去。
- `.gitattributes` 的 `-text` 改动保留，随本次提交进入仓库：它解决的是 `core.autocrlf=true`
  把 tokenizer 资产改成 CRLF、与 `manifest.json` 的 sha256 对不上的问题。改后两个文件的实测
  sha256 与 manifest 完全一致。
