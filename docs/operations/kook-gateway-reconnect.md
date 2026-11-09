# KOOK Gateway 心跳与重连

本页描述 `plugins/kook-bot/src/gateway.ts` 的连接维护行为。网关由启用且
`listen: true` 的 KOOK 插件持有；运维核对连接时，应同时检查该插件的加载状态。

## 当前行为

- 成功收到 HELLO 或 RESUME 后，每 30 秒发送一次 Ping。
- 上一次 Ping 尚未收到 Pong 时，下一个心跳周期关闭该连接；Pong 到达后清除等待标记。
- 当前连接关闭时清除心跳，并登记一个 2 秒后的重连任务。同一时刻只保留一个待触发任务。
- 重连失败会记录错误并再次安排 2 秒后的重试。首次连接阶段失败也进入该路径。
  获取机器人身份的 REST 调用发生在此分支之前，其失败仍向调用方报告。
- `stop()` 清除心跳、待触发的重连计时器和等待 Pong 的标记，并关闭已经记录的 socket。

可用于定位阶段的日志包括“KOOK Gateway 已断开，2 秒后重连”、
“KOOK Gateway 心跳超时，主动断开并重连”和“KOOK Gateway 重连失败”。
排查时记录时间与错误类型，避免把配置 token、完整带认证 URL 或私密消息复制到诊断记录。

## 隔离验证

2026-11-09 在 Spark 使用现有 Node 22 和单 worker 执行：

```sh
cd /home/ayerelysia/Elysia/Elysium/Elysia-Harness/dsh
export PATH="/home/ayerelysia/.local/share/node-v22/bin:$PATH"
node node_modules/vitest/vitest.mjs run --config vitest.elysia.config.ts \
  --maxWorkers=1 --no-file-parallelism ../plugins/kook-bot/tests/kook.spec.ts
```

结果为 13 项通过。新增的两个假时钟用例分别检查未收到 Pong 时关闭旧连接，
以及持续收到 Pong 时继续发送心跳。帧解析用例同时确认 Pong 信号的识别。
测试通过 mock socket、mock HTTP 返回、临时配置目录和进程内插件作用域完成，
没有连接真实 KOOK、发送平台消息或访问正式 storage。

本次隔离测试没有覆盖真实服务握手、完整断网重连和等待 HELLO 期间卸载的竞争。
提交与后续运行验收应保留这个范围区别；重连计时器的失败重试及 stop 清理也未由新增用例单独覆盖。
