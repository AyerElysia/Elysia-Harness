# BreezeTTS2 官方语音服务操作说明

当前聊天入口为 Spark 的 `http://127.0.0.1:7862`。它由无模型的单进程兼容入口转发到 `http://127.0.0.1:7863` 的官方推理服务。不要直接把所有调用端改成并发访问官方端口。

## 1 组件与归属

| 名称 | 作用 | 当前策略 |
|---|---|---|
| breeze-tts2-official | 固定 daa6cb2e 官方推理，唯一模型实例 | restart=no，7863 仅回环发布 |
| breeze-tts2-gateway | FIFO、期限和 PCM 协议兼容 | restart=no，host network 中仅监听127.0.0.1:7862 |
| breeze-tts2 | 旧本地 fork，停止状态留作回滚 | 不与新入口同时占用7862 |
| breeze-tts2-gateway-stage | 临时验证入口，已停止 | 不用于生产 |

操作前核对容器真实 ID、image、PID/父进程、端口和 owner 标签。不能凭名称相似停止其他服务，也不启动第二个官方推理副本。本任务没有改变 Elysium、主意识或平台连接的生命周期。

## 2 查看是否运行

```sh
docker ps -a --filter name=breeze-tts2 --format '{{.Names}} {{.State}} {{.Ports}}'
curl --silent --max-time 5 http://127.0.0.1:7862/health
curl --silent --max-time 5 http://127.0.0.1:7862/v1/model
```

health 的 ready/backend_ready、busy/queued、draining/drained 分别表示准入、后端和任务状态。ready 不代表实际语音已投递。发现 error_code 或清理隔离时先核查后端，不自动重启推理进程。

## 3 明确启动和关闭

确认旧服务已停止、7862/7863 无未知 owner，且两个新容器仍是验收的版本后，依次手动启动：

```sh
docker start breeze-tts2-official
```

等官方 7863 的 health 正常、model_digest 与验收一致后再执行：

```sh
docker start breeze-tts2-gateway
```

兼容层维护标志位于：

`/home/ayerelysia/Elysia/Elysium/runtime/breeze-official-20261112/gateway-control/drain`

在该受控路径创建 drain 标志会拒绝新合成，已准入任务继续排空；标志不是公开 HTTP 控制接口。等待 7862 health 的 drained=true 后再依次停止 gateway 与 official；drain 时 health 返回503是预期状态，查询不要用 --fail 判断排空。

```sh
docker stop --timeout 30 breeze-tts2-gateway
docker stop --timeout 120 breeze-tts2-official
```

只有核对状态和端口后才移除本任务的 drain 标志、重新准入。不要删除整个控制目录、runtime、模型或参考声音目录。不要设置 watchdog、循环重拉或自启动。

## 4 构建来源

Dockerfile 位于 `services/breeze-official/Dockerfile`。构建上下文必须是完整官方 Git archive，不使用本地修改后的 AI/breeze-tts 工作树。

- 上游 commit：daa6cb2efe5471f09369229f322d20bb956cb3c3。
- source archive：Elysium/runtime/breeze-official-20261112/source-daa6cb2e.tar。
- 依赖基础镜像：sha256:30d6ea28f36ed09b262eeb2eac0f9e1ca4081166179a24bd32b5c87308ef880a。
- 已构建镜像：elysia-breeze-official:daa6cb2e，ID sha256:836e408f4771412c7d6948f92be3059191cf0274760e9295d607c86caa153774。
- 源码加载目录：/opt/breeze-official；依赖目录 /opt/breeze-pkgs 只读，旧 fork 不挂载。

官方源码未修改。Spark 依赖底座沿用已验证的 Arm64 CUDA 环境，不运行官方 requirements 将工作中的 torch 强降到 H100 示例版本。调试 fast flags 必须另作性能和声音验收。

## 5 固定声音与验证

default 配置源仍为：

`/home/ayerelysia/Elysia/Elysium/config/plugins/tts_voice_plugin/config.toml`

模型只可提供口语与 expression_instruction；参考音频、转写、基础 instruction、CFG 与 seed 由可信配置给出。不在日志或报告复制私人配置内容。声音基线和实际语音回执见 [迁移验收](../report/2026-11-12-breeze-official-service-migration.zh.md)。

`services/breeze-official/verify-client.mts` 调用原 requestBreeze，只打印元数据和哈希；仅限指定本机测试端口和 runtime 新 WAV 路径，不发送聊天消息。运行真实合成前检查无其他推理任务，且有当前测试授权。

`request-voice-test.mjs` 的 send 模式会递交真实主意识请求，必须有当前用户授权、核实收件会话，并复用稳定 requestId；不要把它当健康探针重复运行。observe 模式只读本次请求及匹配语音工具的结果元数据，不打印凭据或无关历史。

## 6 显式回滚

先核对并排空新 gateway，停止 gateway 和官方推理；确认旧容器身份、原 checkpoint 和7862端口后，再手动启动旧 breeze-tts2。不要同时启动两个7862 owner，也不要自动重发结果未知的聊天投递。

旧容器、旧 Git commit、权重和参考音频均保留。切回后重复健康和明确授权的语音回归，记录回滚原因；不是把失败隐藏成仍在使用官方版本。
