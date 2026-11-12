# 爱莉定制 Q8 通话合成服务

这是实时通话专用服务，容器名 `breeze-elysia-cpp-q8`，仅监听 `127.0.0.1:7865`。它运行已转换、量化并试听认可的爱莉微调 GGUF 完整 Q8 权重，不使用深度量化 dd4。

普通聊天和 `send_voice` 继续使用 7862／7863。本目录的启动、停止、故障排查都不能替代或停止那两个服务。

## 启动与状态

在 ElyHarn 仓库执行：

```sh
./services/breeze-elysia-cpp/start.sh
curl -fsS http://127.0.0.1:7865/health
docker ps --filter name=breeze-elysia-cpp-q8
docker logs --tail 100 breeze-elysia-cpp-q8
```

健康响应应为：

```json
{"status":"ok","sample_rate":24000,"ws_port":0}
```

脚本幂等：健康时不重复启动；同名停止容器只执行 `docker start`；容器不存在才按固定镜像 ID、模型路径和端口创建。`restart=no`，机器或 Docker 重启后需人工启动，没有 systemd、自动重拨或后台守护逻辑。

## 停止与恢复

只有明确停用通话合成时才执行：

```sh
docker stop breeze-elysia-cpp-q8
```

恢复用同一个 `start.sh`。不要删除源模型、GGUF、参考音频或普通聊天容器。停止 7865 不影响 7862／7863，但实时通话将无法合成语音。

## 固定部署边界

- 服务只绑定宿主机回环地址，不对局域网或公网开放。
- 容器内 HTTP 为 7865，WebSocket 明确以 `--ws-port -1` 关闭。
- 固定使用 `breeze-tts-2-elysia-q8_0.gguf`，不是通用模型，也不是 Q8-dd4。
- 构建产物、GGUF 和镜像必须与本目录及工程 README 中记录的版本一致。
- 浏览器不能选择服务地址、模型或参考音频。`voice-call` 部署项 `breezeServerUrl` 默认且当前显式配置为 `http://127.0.0.1:7865`；其余参考音频、转写、instruction、CFG 和 seed 仍来自既有 `breezeConfigPath`。
- HTTP 断流没有单独 cancel ACK。取消证据是客户端 AbortSignal、响应体取消，以及旧请求释放后下一条请求被接受；不能把本地 socket close 时间写成服务端取消确认。

## 共享 GPU

7865 与官方 PyTorch 服务共享同一块 GB10。资源竞争可能让生成慢于实时，空闲短句测试和竞争测试必须分开记录。若需彻底停用本服务，先确认没有活动通话；脚本不会自动杀进程或抢占普通聊天任务。
