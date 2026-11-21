# 爱莉直播：上游 dsh-livestream 的 ElyHarn 适配

`@elysia/dsh-livestream` 从 [luckui/dsh-livestream 的固定提交 6c2f405b5520bea932808c224ba9ca6d65f41756](https://github.com/luckui/dsh-livestream/tree/6c2f405b5520bea932808c224ba9ca6d65f41756/packages/dsh-livestream) 导入代码后适配，保留原控制台、舞台、模板和直播工作流。[UPSTREAM.json](./UPSTREAM.json) 记录导入前各文件的哈希，[UPSTREAM.md](./UPSTREAM.md) 说明来源；代码 MIT 与字体 OFL 授权保留。

此前自写的简化直播原型已保存在 Spark 的私有工程归档中，不随当前插件发布。恢复版本时使用已验证的提交，并保留原生会话与运行数据。

## 保留的上游功能

- DSH 侧栏「直播」打开原完整控制台：房间连接、账号登录、舞台预览、主人说话、模拟观众、节奏与告示板等操作。
- 原 `console`、`stage`、挂件及角色/模板装配机制；保留 `default`、`sunset`、`deepsea` 三个模板与字体。
- 弹幕、礼物等直播事件进入直播工作流；视频展示、媒体播放回执、游戏画面及工具接口保留。
- 原 OBS 发布路径保留为明确选择的另一模式；当前部署默认由 Windows 直播姬持有推流，不会通过「开始直播回应」启动 OBS 或替直播姬开播。

角色目录仅提供 `elysia` 的工程 SVG 占位和 image manifest，供模板正常装配；这不代表爱莉真实立绘或动画已迁移。没有导入上游大肥鱼角色素材及默认人格。用户角色包仍可覆盖内置占位。

## ElyHarn 接入

宿主恢复固定的原生会话 `elysia-livestream`，工作目录仍为 `homes/web/livestream`，使用 DSH 原生持久化与已有驻留提示词装配。控制台不开随机会话、不切换上游默认人格、不建立另一个直播人物。

当前不运行独立观众记忆、人格蒸馏或自动观众打分。工程注意窗口与节奏设置只提供调度机会，主体可以回应或略过；原兼容字段不意味着对应独立执行链已启用。直播输入与对外表达通过原生会话记录，不能混入私聊历史。带平台写入副作用的工具需要显式允许，保留上游工具接口不等于自动开放外发权限。

语音沿用本机爱莉的 Breeze 固定音色，不要求豆包 Key，也没有云端语音回退。控制台的可用状态表示本地配置/参考文件检查通过，不证明 TTS 服务在线。音频使用明确的 WAV MIME；总时长来自 PCM 长度，逐字字幕标记为估算，不冒充实测对齐。

直播仅在共用的 `requestBreeze` 上增加总时长和字幕投影，不维护另一份 HTTP 合成实现、本地推理队列或 409 重试环。Python、主意识与直播共用服务端的有界 FIFO/唯一 worker；一次请求预算覆盖服务端排队到 PCM 读完，调用者取消传播为 HTTP 断连。`requestTimeoutMs` 只可缩短配置预算，不能绕过服务端上限。503/504 或断流明确失败，不自动重新合成。

舞台按真实媒体事件回报 `ended`、`failed`、`cancelled`、`timeout`。只有实际 `ended` 更新最后播完的语句；拒播或加载失败不会变成成功回执。失败已经交还语音所有者，点击启用只作用于后续语音，不自动重播已结束调度的旧句。控制台预览静音、不作为出声舞台，也不发送语音完成回执。

口播参数、观众事件引用、播放回执和默认工具见 [直播工具说明](./TOOLS.zh.md)。

## 界面与访问

主人控制台使用 DSH 已登录界面的侧栏「直播」。`/api/dsh-livestream/*` 属于 DSH 鉴权面，包含设置、登录、启停回应及模拟输入等管理操作。

舞台默认监听 Spark `127.0.0.1:3300`，Windows 通过本机 SSH 转发使用。直播姬可添加两个浏览器源，`http://127.0.0.1:3300/audio` 只播放语音，`http://127.0.0.1:3300/subtitles` 只渲染透明字幕。字幕由真实起播事件显示，由终态清除。音频源优先于完整舞台接收下一句，每句只选一个播放连接。

`/source` 提供完整舞台，`/stage` 提供静音预览。DSH 直播控制台的「启用试听」用于本地彩排，点击后可直接在页面听到后续回复。已打开的旧版舞台加载新版时需要刷新。

舞台完整地址带私有 capability token，仅用于展示、媒体读取和有限播放回执，不提供账号或推流管理。无 token 的本机兼容跳转仅允许直接回环连接、实际端口的回环 Host，且拒绝转发标记。公开代理不能借此领取舞台能力；不要关闭 DSH 鉴权或将私有 token 写进文档。

运行设置、舞台 token 和工程状态位于 `homes/web/dsh-livestream`，已在 `.gitignore` 排除。它们与原生会话持久化是不同用途，不应当作可提交配置或人物记忆库。

完整连接、声音验收与回滚步骤见 [直播运维说明](../../docs/operations/livestream.md)。

## 定向验证与构建

在本目录、使用现有 Node 22 与已链接依赖执行；这些命令不会启动正式插件。UI/播放器用例使用假媒体和隔离 fixture，不实际发声、调用模型或推流。

```sh
node ../../dsh/node_modules/vitest/vitest.mjs run --config vitest.config.ts test/console-client.test.ts test/stage-playback.test.ts
node build.mjs --client
```

`--client` 只构建原控制台 `lib/client.js` 与独立舞台 `lib/stage.js`；控制台复用 DSH 的 React，独立舞台包含自己的浏览器依赖。完整插件构建使用 `node build.mjs`。构建产物、正式服务重载和真实直播软件混音验收是不同步骤，不能以构建或模拟测试通过代替已部署、已开播或观众已听到的结论。
