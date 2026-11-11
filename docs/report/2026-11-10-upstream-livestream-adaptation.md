# 以原版 dsh-livestream 为基础迁移直播插件

## 范围与来源

按用户要求，直播功能从自写的 @elysia/livestream 切换为 @elysia/dsh-livestream，继续使用 Spark 本地 Breeze，Windows 本机 B站直播姬负责推流和混音。

原始代码为 https://github.com/luckui/dsh-livestream 的 6c2f405b5520bea932808c224ba9ca6d65f41756。UPSTREAM.json 记录 98 个导入文件的原 Git blob/SHA256；原版控制台、舞台、三套模板、视频、管理流程及许可证保留。原大肥鱼人物资产不导入；爱莉角色当前使用明确的工程占位图，原图片/视频角色包加载能力保留。

## 关键适配

- 使用既有 elysia-livestream 会话 id/cwd 与 scoped standing prompts。不建立新人物、独立观众长期记忆或自动蒸馏；不修改主体文件。
- 完整归一化直播输入先进入原生 DSH 插件 journal。分页投影持久化稳定 intent、消息 id、页字节位置；从 native inbox 记录折叠恢复，避免崩溃后丢失或重复投递。只有操作人显式启用回应后才恢复工作。
- 删除输入的语义评分、自动重要性丢弃与字数硬要求，使用 FIFO 字节分页；未计算的热度显示“未估计”。
- 主体会话默认只装配读、观察、播放与略过能力；平台写动作默认空授权列表。操作者口播请求须由主体自行采用，不直接伪装成主体已说的话。
- 新 Breeze 适配覆盖完整 PCM 读取和 WAV 封装的单并发所有权；舞台播放 WAV。仅真实浏览器 ended 算成功，拒播、错误、取消、超时独立记录；视频同样不以时钟到期冒充播放完成。
- runtime 显式异步初始化，作用域卸载释放服务器、SSE、ASR、广播检查和计时器；导入不启动服务或恢复播出。
- 旧扫码保存的父目录私有环境文件继续作为 Cookie 的只读最终来源；优先原生凭据和显式环境值，不复制或写回旧私有文件。
- 管理路由沿用原生 DSH 鉴权。舞台以独立 capability 展示媒体和接收有限回执；本机 /source bootstrap 只接受精确回环地址、Host 和无转发头的请求。

## 验证记录

最终全包验证：301 项中 295 通过、6 项沿用原有跳过，0 失败、0 unhandled errors。Host 与相关新增测试 noEmit 0 diagnostics（492 files）；前端认证传输与 UI 14 项定向测试通过，13 个前端/舞台/测试入口 noEmit 0 diagnostics；最终前端构建成功。

隔离真实 Stage/StageServer/Packs 与最终舞台脚本，经 Windows Chrome 播放既有 73,004 字节诊断 WAV。首句如实回报 playback-rejected；点击启用后，用新 id 取得真实 ended，未重放已失败请求。回执仅证明浏览器播放结束，不能替代直播姬混音和平台回放验证。临时诊断服务器和转发已关闭。

新插件低层 synthesize 本地 Breeze 实测另生成正常 WAV：2.385 秒、73,004 字节、1.520 秒、PCM16 mono 24kHz，归一化 peak 0.756470、RMS 0.172161；没有将它播出。

验证未调用真实模型、未发送平台测试消息，未向直播间播出诊断内容；未向正式会话注入测试输入，未修改人物文件。

## 运行切换

在核对旧 Web 的 pid、父进程、uid、cwd、Node、完整参数和 3299/3300 端口归属后，精确 SIGTERM 原进程，并确认父子退出及端口释放。仅替换 profile 中直播包的 dependency/bundle/config，创建精确本地包链接，随后以原启动参数和环境启动一次；没有新增守护、自动恢复或服务。

认证传输与旧 Cookie 来源接入修复后，同样核对所有权并正常重载一次，新 Web 为 98894 / 98882，3299/3300 仍只监听回环，舞台 capability 保持不变，已有浏览器源可自动重连。

首轮切换备份：/tmp/elysia-upstream-cutover-2m1yeys5。原 Web 3149923 / 3149911 已退出，新 Web 初次为 63220 / 63208。运行配置沿用直播间 31581575、本机 3300/source、Breeze 音色，publisher=livehime。settings/token 单独忽略，文件权限 0600；没有将凭据放进控制台文档或代码。

用户已确认刷新直播姬浏览器源。原版控制台 raw fetch/EventSource 在当前 DSH 鉴权下返回 401；现参照原生 client-hmr 使用公开页面认证 carrier，采用文档相对路径，SSE 经同一认证 fetch 增量解析，并由 AbortController/reader.cancel 释放。没有读取秘密 store、将管理 token 放 URL 或关闭鉴权。

Windows Chrome 实机验证已完成：侧栏“直播”打开原版控制台，Breeze 显示已配置，三套模板可见，内嵌舞台预览带 preview=1 且静音，当前非预览舞台连接数为 2。原 Cookie 来源的账号查询成功；使用现有房间配置执行只读连接后，显示直播间已连上（Test）。保持“未开播/没在播”，没有点击开始直播回应、推流、模拟观众或发送测试输入。保存的控制台截图仅截到源地址之前，不包含舞台 capability。连接数不能单独证明具体客户端身份或直播混音结果。

## 回滚与边界

旧 plugins/livestream 保留，不与新包同时挂载。回滚须先核对当前所有者并正常退出，再针对性恢复本轮 profile 备份和对应包挂载；不要覆盖其他并行改动，不执行全工作区安装，不启动任何 guard。

本报告的初次迁移验收覆盖静态 UI 和低层声音，未执行真实 /onair；后续真实链路测试发现并修复原生工具接口及15秒语音预算问题，成功回执和边界详见 2026-11-10-livestream-voice-acceptance.md。

本轮没有提交或推送。待最终 UI 接入检查完成后，工程改动仍留在原 checkout，和其他在途改动分开审阅。
