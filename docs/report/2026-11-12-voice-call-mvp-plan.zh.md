# 最简实时通话规划核查

日期：2026-11-12（UTC+8）。交付为 `plugins/voice-call/PLAN-MVP.zh.md` 审批稿及 README/总体需求的决策同步。本轮没有实现运行功能。

用户明确：独立新语音 Session；复用既有固定提示词管理；认知系统提示词只用SOUL。保留此前 Realtime Mini 与官方 Breeze 固定音色的分工。

只读核查发现：

- 既有 standing-prompts 可只选 SOUL，complete=true、section interpolate=false；原加载逻辑仅trim边缘空白。
- complete只保证系统section选择，不清空工具/contexts；不能复用composeMainAgent的整套能力。
- 当前 create/resume 走普通ReactLoopAgent；公开register/enter支持真正自定义Agent，但尚无Realtime驱动实现。
- appendPluginRecord 明令不供外部插件生产使用；原生绑定与合法持久记录是审批后的第一个离线门槛。
- 现有Web有认证fetch/SSE和侧栏模式；连续PCM播放器和sideband仍需新增并验证载体流式行为。
- 共享Breeze聊天语音已在先前迁移验收中获得用户确认；既有性能样例不能证明自然实时，MVP保留短测放行条件。

建议范围：现有Web单人、空工具、单并发、10分钟、新provider连接不自动加载旧通话历史；录音和原声持久化边界待用户明确审批。没有把这些建议写成已实施决定。

本轮只读取工程源码、指令和上游官方文档；未读取SOUL正文、密钥或私人聊天，未创建Session，未调用OpenAI或TTS，未发送平台消息，未改配置/服务/代码或重启。未修改并发任务持有的docs/architecture.md、主意识或dsh，未安装依赖、提交或推送。

校验：两项独立只读审查通过；已修正总体需求的旧阶段顺序、SOUL会被发送给获授权provider的隐私边界，以及speech_started后停播的真实延迟措辞。完成内容读回、相关链接和敏感字串检查。审批前没有运行验收，不将文档审查称为通话功能测试通过。
