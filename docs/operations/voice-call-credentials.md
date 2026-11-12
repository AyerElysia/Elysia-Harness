# 实时通话凭据维护

当前引用名：`OPENAI_REALTIME_API_KEY`。它由 Spark 的 ElyHarn Web 受控凭据服务保存，真实值不进入插件源码或文档。用户已明确授权先保存其先前给出的 key，并在之后自行替换；仍建议轮换曾在聊天中披露的 key。

## 查看是否已配置

在 Spark 原仓库根目录运行只读检查：

```sh
node plugins/voice-call/scripts/set-credential.mjs --describe
```

仅输出引用名、configured 和来源，不打印值。它复用本机既有服务的运维认证，不创建新账号，不触发模型调用或重启。现有 Web 未运行或本机认证不可用时会明确失败。

## 替换

通过既有受控凭据管理入口修改同名引用即可。也可在 Spark 私密终端、仓库根目录使用辅助脚本；不要把 key 粘进命令参数、源码、截图或聊天：

```sh
read -rs -p 'OpenAI API key: ' voice_call_key
printf '%s' "$voice_call_key" | node plugins/voice-call/scripts/set-credential.mjs
unset voice_call_key
```

输入不回显，脚本只从 stdin 接收；成功后只描述配置状态。空值/明显格式错误在写入前拒绝，不用空值替代已有 key。命令需使用当前服务器安装的 Node22运行环境，不能为此安装/改动全仓依赖。

每次开始通话重新读取该引用；已开始的一通仍使用其建立连接时的凭据，不冒称热切换了上游连接。替换后下一通生效，无需重启主意识或共享 TTS。移除引用后不得自动改用其他 provider/key。

本说明不证明目标模型权限、费用结算或真实音频链路已验收；这些状态见 [实施记录](../report/voice-call-mvp-20261112.md)。
