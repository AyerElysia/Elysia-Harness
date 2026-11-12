# LiveKit 通话试验（隔离）

复用 LiveKit Python Agents 的 OpenAI Realtime 文本输出与独立 TTS、官方 LiveKit 浏览器 SDK 和音轨播放器。模型为 `gpt-realtime-2.1-mini`。不使用 OpenAI 音色、不启用工具、只读既有 SOUL、不保存原声、不启用记录/导出、不自动重拨。此阶段不接 DSH 原生 Session，也不导入旧历史。不要用这个试验替换正式通话或当成历史落账已验收。

## 固定媒体和声音边界

- OpenAI 仅由 worker 通过 Spark 既有通话专用回环代理 17878 访问；原声会送给 OpenAI 处理。API key 只从现有私有引用读到 worker 进程，不经网页、不打印。
- Breeze 只用已存在的专用 Q8 实时服务 `127.0.0.1:7865` 的官方兼容接口、部署端固定 default 参考，不改推理或声音。HTTP 输出增量解帧进入 LiveKit；不经过旧 SSE/PCM 自制播放回执路径，不影响聊天 7862。
- 新 LiveKit 容器、worker、网页独立运行。Spark 只在 loopback 发布 18780（信令）、18781（ICE/TCP）、18790（网页），worker 健康仅 Spark loopback 18791。不接 LiveKit Cloud；不改 Ayla LiveKit、DSH Web、Breeze、系统代理、启动配置或防火墙。

## 操作

在 Spark 原仓的本目录，用私有 `mktemp -d /tmp/elyharn-livekit-pilot.XXXXXXXX` 建运行目录；用 `uv venv` 创建该目录的 venv；Spark ARM64/Python 3.12 使用 `uv pip install --no-deps -r requirements.spark.lock`（指定该 venv 的解释器）。锁只使用 PyPI wheels；也可在受控网络下载匹配 wheels 后用 `--offline --find-links` 安装。前端目录用 Node 22 运行 `npm ci --ignore-scripts`、`npm run build`，由 Python 服务托管静态构建。

确认四个端口和容器名无占用后，使用该 venv 的 Python 在前台运行 `python -B pilot.py --runtime <该私有目录>`。程序只启动一次；Ctrl+C 关闭本次 worker 与确切容器，无自动拉起。启动时写 0600 的试验配置和日志；不要分享这些文件。用户本机 SSH 只需要 3 个回环转发，须先核对本机没有其它进程占用这三个端口：

```text
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:18790:127.0.0.1:18790 -L 127.0.0.1:18780:127.0.0.1:18780 -L 127.0.0.1:18781:127.0.0.1:18781 dgx-spark
```

浏览器打开 `http://127.0.0.1:18790/`。用户亲自勾选说明、开始和授权麦克风，最多 10 分钟；断开后不会自动接起。试验凭据每次前台启动重新生成，网页只取得短效、仅当前房间且只能发布麦克风的 token。

## 验收

`python -B -m unittest -v` 检查边界；服务启动后运行 `python -B smoke_rtc.py <运行目录>/livekit-private.json`，两个无硬件客户端经同一个本地 RTC 交换短测试音，不创建 OpenAI 会话。显式加 `--breeze` 才额外调用一次专用 TTS（合成固定测试句，仅内存播放轨）。本机浏览器实际听感与插话需用户短测，至少连续三轮、播报中插话、插话后继续、挂断后释放。网页、合成成功或服务器音轨验收均不能单独证明用户已经听见。
