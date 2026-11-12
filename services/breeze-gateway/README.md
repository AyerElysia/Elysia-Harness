# Breeze 官方 API 兼容入口

这是 HTTP-only 的有界 FIFO 和协议转发层，不是推理程序。仅官方后端加载模型、准备输入、采样和生成 PCM；本目录不导入 torch、Breeze 或 codec。

从本目录启动（由部署 owner 核对端口与运行归属后执行）：

```sh
python gateway.py --host 127.0.0.1 --port 7862 --backend-url http://127.0.0.1:7863 --drain-file /run/breeze-gateway/drain
```

必须保持单进程、单 Uvicorn worker，不能用多 worker 冒充共享调度。默认最多 8 个等待请求、排队 30 秒、整条请求 300 秒、取消清理 10 秒；调用端 X-Breeze-Timeout-Ms 只能缩短整体预算。原始 multipart 字节直接转发，不修改参考音频、转写或表达参数。X-Breeze-Client 为兼容诊断字段，不作为身份或鉴权，也不写日志。

POST /v1/audio/speech 保留 audio/pcm、X-Sample-Rate、X-Sample-Format:s16le，并额外返回本接入层的 X-Breeze-Request-Id。只有官方 409（明确未接单）允许在有界清理窗口内重试，不重试未知传输失败。开始发 PCM 后发生错误会中断 HTTP 流，不发送“正常结束”，防止聊天端把半条音频作为成功 WAV。

GET /health 保留 status/sample_rate 并显示 backend_ready、ready、busy、queued、draining、drained 和明确错误码。GET /v1/model 代理官方模型信息。健康 ready 不表示平台语音已投递或实际播放。

维护时在部署 owner 控制的本地路径创建 drain 文件。新任务明确返回 503，已接受队列继续排空；等待 health.drained=true 后才能安全切换。移除文件恢复准入。没有公开管理或取消 HTTP 接口。请只绑定 loopback；本服务不替代远程调用鉴权。排队仅内存持有，进程意外退出不承诺任务恢复。

断连会停止转发并关闭官方响应流。HTTP close 不是 GPU 清理完成的证明；后续官方 409 仍受单一 slot owner 和清理期限约束。清理超时或忙碌超过宽限时隔离接入并报告 backend_cleanup_unconfirmed / backend_busy_after_grace，需 owner 核对后端后显式重启此无模型接入层，不能自动恢复或重启模型。

本阶段不暴露 batch；普通聊天/直播继续调用完整语音接口。未来通话另接 PCM 消费，不改变 send_voice 或 requestBreeze 的完整音频返回值。

离线测试（仅 mock HTTP，不加载模型或请求实际 TTS）：

```sh
python -m unittest discover -s tests -v
```

依赖版本记录在 requirements.txt；应复用已验明的 Spark 运行环境，不在正在推理的实例中临时安装依赖。
