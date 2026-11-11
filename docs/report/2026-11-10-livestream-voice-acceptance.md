# 直播语音真实链路验收

## 授权与范围

2026-11-10，用户要求检查爱莉是否能语音回复，明确授权发送测试弹幕；随后澄清仅打开直播姬、尚未向 B站推流。本轮不启动平台直播，仅测试实际 B站弹幕输入、主体回复、本地 Breeze 与舞台播放；不以本地播放代替观众侧音轨验收。

## 已确认的问题与操作

1. 本机 3299/3300 SSH 转发已退出，UI 仍保留旧状态并显示连接中断/Failed to fetch。确认本机两端口无 owner 后，手工启动一次隐藏 SSH 转发（PID46820），未启自动重拉。
2. 原生 Tools 的 restrict 只接受全局工具名。新插件把 scoped READ_ACTIONS 传入 allow，真实 /onair 失败；后续 create 被正常 SessionAlreadyExistsError 拒绝。已改为 allow:[] 隐藏全局工具，scope-local 工具继续按明确 capability 注册，不改历史、cwd、header 或 lock。新增真实原生 Tools fixture 验证可见性、写权限和卸载。安全诊断仅保存 phase/name/code/source 首帧，不保存错误正文/凭据。
3. 受控重载后 /onair 成功，固定原会话恢复。Chrome 已由用户手工完成验证码与登录，运维只发送一条真实弹幕“爱莉，运维测试，能语音回应吗”。原生 input seq416 与文本精确匹配；主体 turn52 结束，4 条 assistant、3 个工具结果、0 工具错误。未把本地模拟冒充平台输入。
4. TTS 开场 seq392 的 61 字合成于 15.002 秒被取消；这是上游面向云合成遗留的 15 秒硬预算。之后本地服务连续返回 409，本次测试对应 say seq440/444 因 6 次 busy 失败，没有播放成功回执。已删除这层 15 秒预算，保留调用者/lifecycle 取消，并由本地 adapter 的有限部署超时、排队与重试负责资源边界。
5. Breeze 容器 /breeze-tts2 只读检查表明，同步 StreamingResponse 生成器仅在 finally 释放独占锁；客户端断开没有及时停止同步推理，且外层没有显式 close。一次 accepted 200 后超过 6 分钟持续 409；现有 health 仅证明 HTTP 服务在线，不能证明推理槽空闲。不能仅凭日志断言仍计算或锁残留，后续恢复必须明确记录。

## 真实运行所有权

原 Web 98894/98882 在核对 uid、cwd、完整 argv、Node22 与两端口归属后正常退出；诊断版 145503/145491，修复 scope 后为 156802/156790。均一次性使用原 argv/env 启动；没有后台恢复。日志分界见 /tmp/elysia-live-acceptance-reload.json 和 /tmp/elysia-live-acceptance-fixed-reload.json。

Breeze 准确容器 id 前缀 763a9523cc8d，host PID1271514，实际入口 python -m breeze_infer.api；仅回环 7862，工程源码只读挂载。本轮先正常 /offair 暂停自动回应；确认该容器唯一 python/GPU 进程、无 7862 ESTAB 客户端、无其他任务后，精确执行一次 docker restart --time 30，仅操作此完整容器 id。PID1271514→250654，启动于08:45:41+08；约08:47:34+08 HTTP/lifespan启动完成，无异常。原有 unless-stopped 策略、镜像、命令与挂载未改变，没有新增恢复机制。留档 /tmp/elysia-live-breeze-owned-restart.json。随后受控重载 Web252881/252869 加载合成预算修复，见 /tmp/elysia-live-acceptance-tts-reload.json。

## 验证与待完成

原生工具修复：13 定向测试通过，noEmit 0 diagnostics；合成预算修复：28 定向测试通过，noEmit 0 diagnostics。未与运行中的正式 authority 竞争。

修复后重新开启直播回应并连接房间。开场 say seq537 首次真实 ended；19.373 秒是合成及播放总时长，不能用来单独推断合成耗时。

随后通过同一已登录 B站页面发送第二条明确复测弹幕“爱莉，语音复测，早上好呀”，得到完整证据链（均为2026-11-10，+08）：

- 原生 input seq548：08:51:24.018，platform=bilibili、room31581575、测试句精确匹配。
- 主体 turn62：start554/end560，assistant source558，一条 assistant，无工具错误。
- 本地合成：say start08:51:28.353，完整 audio/wav 在08:51:35.888广播，合成7.535秒，音频5.120秒。
- 真实舞台回执：say id754b5f06-38e5-4070-b0f8-efe277eed5f0，native activity seq561 state=ended，08:51:41.566；WAV广播后5.678秒结束。
- 从收到平台弹幕到播完17.548秒；say合成及播放合计13.213秒。界面显示实际回复：“早上好呀，小星星。声音我出了，你那边听得见吗♪”。
- 本机3300 TCP客户端归属：chrome.exe PID39032（静音控制台预览）、bililive_browser.exe PID88856；服务器非预览 speaker=1，临时诊断连接明确preview=1/speaker=false，不发送任何播放回执。
- 只读 observer261320 已正常停止、previewClosed=true、exit0。首条失败 seq416/440/444 未修改、未重标成功。没有发送更多测试消息。
- 已保存控制台截图，截取源地址之前的区域，不包含舞台 capability。当前回应开启、房间已连接，平台推流保持未启动。

## 边界与剩余工作

本次已经验证实际弹幕→主体回复→本地完整 WAV→直播姬浏览器进程连接的舞台真实 ended。用户没有推流，未验证 B站观众侧最终混音，不能把浏览器播放回执当成平台音轨证据。

Breeze 服务端“客户端断开后同步推理/生成器锁及时释放”的能力仍需由其工程 owner 单独完善；本轮修复了调用方过短预算，并通过准确一次重启清理这次遗留占用，没有篡改 busy/伪造取消成功。后续取消/超时若再导致持续 busy，须核对实际容器和当前任务所有权，不能固定周期重启，也不能拿 health=ok 当作推理槽空闲。

上轮静态 UI/底层 TTS 验证没有执行真实 /onair，未覆盖原生工具接口和较长主体语音的整体路径；本轮发现并修正了这些遗漏。
