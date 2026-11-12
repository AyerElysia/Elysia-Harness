# BreezeTTS2 官方服务迁移验收

日期：2026-11-12（Asia/Shanghai）。结论：官方后端与兼容入口已切换，原聊天工具真实合成和 KOOK 投递通过；用户也已明确反馈收到、播放和音色均正常，反馈与平台回执分别记录。

## 1 实际变更

官方推理源固定为 `daa6cb2efe5471f09369229f322d20bb956cb3c3`。取完整 Git archive 构建镜像，未改官方模型加载、prepare_inputs、采样、codec 或流式实现。

- 官方容器：`breeze-tts2-official`，宿主机仅 `127.0.0.1:7863`。
- 兼容容器：`breeze-tts2-gateway`，host network 中只绑定 `127.0.0.1:7862`，单进程单 Uvicorn worker，不加载模型。
- 原容器 `breeze-tts2` 已空闲排空后停止，退出码 0，保留作明确回滚，不再参与请求。
- 临时验证容器 `breeze-tts2-gateway-stage` 已停止。
- 两个新容器均 `restart=no`，没有添加后台自恢复。
- 未重启主意识、KOOK、NapCat、Ayla 或其他服务；未改模型工具签名、会话历史或主体文件。
- 未安装依赖、未执行 pnpm install、未改 vendored dsh 或提交/推送。

应用兼容层位于 `services/breeze-gateway/`。只做原始 multipart 转发、有界 FIFO、总预算、断连清理、维护排空和 PCM 头校验。模型推理仍全部来自官方代码。

## 2 版本与声音证据

官方源码 archive：

`/home/ayerelysia/Elysia/Elysium/runtime/breeze-official-20261112/source-daa6cb2e.tar`

SHA256：`4afaa9f68a8f97e79d7f1b148b8373a8c0cb6a3f57fdbde7c15ce892f2e5e100`。

推理镜像：`elysia-breeze-official:daa6cb2e`，实际 ID：

`sha256:836e408f4771412c7d6948f92be3059191cf0274760e9295d607c86caa153774`。

该镜像复用已工作的 Spark Arm64/CUDA 依赖底座 `sha256:30d6ea28f36ed09b262eeb2eac0f9e1ca4081166179a24bd32b5c87308ef880a`，实际为 torch 2.13.0+cu130、transformers 4.57.3、qwen-tts 0.1.1。没有把官方 H100-oriented requirements 强行安装到 GB10；这是官方推理源码加 Spark 已验证依赖，并非声称使用了官方预构建镜像。

官方代码实际位于 `/opt/breeze-official`；旧 fork 未挂入，PYTHONPATH 只优先指向官方源码和只读 Qwen 依赖。容器内三份关键文件与官方 archive 校验一致：

| 文件 | SHA256 |
|---|---|
| breeze_infer/api.py | acee4503bcdddfef20ab1078d98d2079e15b8c2dd1e5cde65fcc0b7245460910 |
| models/fast_streaming.py | 7748cc11fef2a5f54ae82fefc96325673d71b8cb9b1bdd7bb92275c4c100a825 |
| models/generation_breeze.py | fca4c2d134ab1438f63dd7cf7cc1077e2745394db6a90534c9aafcb47c5f9e1f |

权重目录与音频 tokenizer 挂载保持原样，官方 `/v1/model` 返回：

- model_digest：`51f986c4a02eb54d7a984879bb93f87d14a860809df3e4bd6268bc385a9409bd`
- frame_rate：12.5；max_new_tokens：1500；max_batch_texts：128。

可信 default 音色配置仍从原 TOML 在内存读取。未输出私人转写或基础指令正文：

| 资产 | 校验 |
|---|---|
| 参考音频 | 281218 bytes；ca5ae8e697f8ad29c0534c58ebb4ab6137d1bf3d22175b8e0a2d3c7ca30033d7 |
| 参考转写 UTF8 | 66f1c078ba3224394a0e067407fcc4f897c29e0b3840784e337718ee5d7340a8 |
| 基础 instruction | fbc27470d71e185defe5bd5a111a548514dc6a69903c657f84eaacbf816d3c85 |
| checkpoint config | b9a7111056865f0d385e97f395076fdaee454fc11a86c0f6cf0ab773b5faf7a4 |
| checkpoint index | deec569eff0a0b6d4198478a739294f795b9870c9f39389365ed4a04fd5a2cbb |

CFG 3.8、配置 seed=-1 及原客户端稳定 seed 派生不变。参考音频未转码、重剪或替换；没有模型微调或音色上传。

## 3 验证记录

1. 新官方后端先在独立 7863 启动，原服务保持可用。启动前核对容器、PID/父 PID、端口、旧健康空闲及系统可用内存约 103 GiB。
2. 使用未修改的 `requestBreeze()` 和原 default 配置，只在内存覆盖测试地址，真实合成成功。
3. 兼容入口先用 7864 验证，真实 PCM 流和完整 WAV 成功，再停止临时入口。
4. 旧服务健康 busy=false、queued=0 后，执行有界优雅停止，退出码 0；正式兼容入口接管 7862。
5. 正式 7862 的健康、官方模型信息和真实语音合成再验成功。
6. 用户明确 KOOK 也可后，以机器人只读账户列表核对 AyerElysia；未使用另一个近期会话冒充目标。
7. 经原生 session/prompt 排队向主意识递交署名 Codex 的运维测试请求，由爱莉自己选择语音正文并调用 send_voice；没有旁路直接代她合成/发送。

轻量检查：

| 项目 | 结果 |
|---|---|
| 原 Breeze transport 测试 | 13 通过 |
| 原 send_voice 测试 | 6 通过 |
| 新兼容层离线 unittest | 8 通过，network=none，无模型 |
| 独立只读兼容层审查 | 无上线阻断项 |
| 官方和兼容入口真实合成 | direct、staging、production 各一次通过 |
| 默认音色资产 | 与迁移前校验一致 |

真实合成的测试语句含中文内联笑声与自然语言表达控制。正常 PCM 为 24kHz mono s16le，测试完整 WAV 为 257324 bytes、5360ms。正式入口暖态这一次测得首块 PCM 398ms、完整生成 7957ms；这不是扬声器可听延迟、P95 或持续实时通话性能承诺，也未验证 fast flags。

## 4 爱莉实际语音投递

原生主意识：`elysia-conscious-mind`，未创建替身 session。

- 运维请求 requestId：`c1043fca-58ba-4d3a-bc45-b49c955e9f27`。
- 权威记录 anchor seq：17762。
- send_voice call seq：17765；result seq：17766；随后 turn 正常结束。
- 实际工具状态：`sent`。
- 音频：660524 bytes；正文 57 字，带表达控制，不在报告复制私人正文。
- KOOK 目标账号：AyerElysia，经现有机器人列表核实。
- 消息 ID：`a390d4da-38ff-4563-8a04-96d61f6ecce6`。
- 仅递交一个测试请求，观察到一次匹配目标的 send_voice，未重复投递。

平台回执证明发送链路成功，不证明用户已听到，也不能由此推断语音气泡或音频文件在具体客户端的呈现形式。随后用户在本聊天明确反馈：“收到，播放和音色都正常”。因此本次聊天语音的接收、播放与听感也获得用户端确认。

## 5 保留边界与后续

- 普通聊天仍由原工具收齐 PCM、封装完整 WAV 后一次发送；直播共用完整音频接口未改，未来通话需要另加流消费路径。
- 旧 Python 健康探针要求的 status=ok 与 sample_rate 正常；本轮没有启动旧 Elysium 或另向直播现场发消息，不声称这两个真实终端已重新验收。
- 未改变 provider、主意识归属、长期记忆或声音素材，也未使用聊天中披露的 API key。
- 兼容层当前信任有限本地消费者：每请求上传上限 16 MiB，等待队列上限 8；不面向不可信公网。扩大调用面前需补并发上传准入。
- 独立审查建议进一步加固“超时、断连、关闭重叠导致的重复 cancel”清理测试；现有下一请求的官方 409 宽限与隔离保护仍在，不自动重启或抢占。
- 低延迟全双工、英文和全参数组合、直播与旧客户端真实回归未在本轮全部实施，不将聊天成功等同于通话上线。

## 6 回滚与资料

运行步骤见 [官方语音服务操作说明](../operations/breeze-official-service.zh.md)。旧容器和模型资产均未删除，回滚为显式操作：先排空并停止新兼容入口与官方后端，再启动旧 `breeze-tts2`，核对原端口与健康。未知投递绝不重发；不设置静默故障切回。

构建与验证脚本位于 `services/breeze-official/`。本次语音测试 WAV 仅保存在忽略的 runtime 目录，不进 Git。全仓现有并发未提交修改未覆盖、未暂存；没有提交或推送。
