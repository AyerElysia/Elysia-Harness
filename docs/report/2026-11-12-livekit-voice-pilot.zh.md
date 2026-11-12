# LiveKit + Breeze 通话试验：2026-11-12

## 范围与入口

试验代码在 `services/voice-livekit-pilot`，独立容器、worker 和网页。Windows 本机从 http://127.0.0.1:18790/ 进入。继续使用原来的 SOUL、OpenAI Realtime 2.1 Mini 音频输入和文字输出、Breeze 现有 7865 实时推理及固定爱莉音色。LiveKit 音轨处理媒体和播放；不使用旧的播放回执。不改正式 DSH 路由、聊天语音 7862、Ayla LiveKit；暂不接 DSH Session。不保留通话原声、不自动重拨、不对外发布端口。

## 已验证

- Spark ARM64 的 72 个锁定包已离线校验并安装，依赖一致性检查通过。前端 TypeScript 和生产构建通过。用实际 SDK 跑过 19 项离线测试：适配器流式输出和取消、worker 边界与清理、浏览器令牌限制。
- 初次测试仅能建立信令，媒体超时；容器现在仅从实际收包的 eth0 收集候选，不再同时把 lo 映射为同一地址。ICE/TCP 及信令端口仍只对 Spark 回环发布。
- 两个 Spark RTC 测试客户端在同一房间交换音轨，各收到至少 5 个非静音帧。其中一路为真实 Breeze 专用端点合成的固定测试短句；没有用户麦克风、音频文件或 OpenAI 推理。
- 另经原有本机代理验证 OpenAI 精确模型查找返回 HTTP 200，Realtime 握手收到 `session.updated` 并接受仅文字输出。只验证会话配置，未发送 SOUL、音频或生成请求。
- Windows 本机通过 SSH 转发访问网页 HTTP 200、健康检查 ready。回环端口 18780/18781/18790；OpenAI 仍经获批的 17878 回环反向转发。正式 DSH、聊天 Breeze、通话 Breeze 监听正常，Ayla 容器仍在运行。

## 等待实际短测

用户亲自勾选并开始通话，确认三轮有声回复；在播报中插话，应停下旧句并回答新句；挂断后麦克风指示应熄灭。当前已验证分段链路，不视为实际浏览器三轮、插话或用户听感已通过。若浏览器媒体不通，先区分浏览器 ICE 与模型/合成问题，不自动重拨或替换旧入口。

## 本次运行记录

Spark 监督进程 PID 3229530，容器 `elyharn-voice-livekit-pilot`，运行目录 `/tmp/elyharn-livekit-pilot.jZGOLHyj`。Windows SSH PID 94536（仅本次回环转发）。进程号只适用于本次；停止前重新核实启动参数和所有者。没有加入开机启动。运行目录内私有配置、日志不得分享。
