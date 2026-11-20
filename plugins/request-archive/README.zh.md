# @elysia/request-archive

[English](README.md) | 中文

每次模型调用发出去之前，把当时的完整请求写成一个 JSON 文件。会话日志之后怎么压缩、替换，这些文件都不再改。

请求挂在 `llm/stream` 上。写盘失败时，这次调用不会继续发给适配器。

文件在 `/home/ayerelysia/Elysia/Data/requests`，一个调用一个文件。可用配置改目录：

```yaml
- id: elysia-request-archive
  name: elysia-request-archive
  config:
    dir: /home/ayerelysia/Elysia/Data/requests
    maxFiles: 5000
    maxBytes: 536870912
    maxAgeDays: 30
    compact: true
```

每份记录包含当时的 `messages`、`system`、工具 schema、模型、温度和 `sessionId`。取消信号不写入。图片以请求里的附件引用保留，字节仍在附件存储里。

## 存储格式

每次调用追加一个新文件，不读取、不改写任何更早的记录，因此一次写入只序列化自己的请求。记录默认是单行 JSON；需要人工阅读时设 `compact: false`，每份记录会增大约 30%。POSIX 上目录按 `0700` 创建，已存在的 `0755` 目录会在进程首次写入时收紧；Windows 保留继承的 ACL。记录文件是 `0600`。

## 保留策略

`maxFiles`、`maxBytes`、`maxAgeDays` 限定目录，默认 5000 个文件、512 MiB、30 天；设为 `0` 表示不启用该上限。最旧的记录先淘汰。淘汰在写入之后的排队清理里执行，绝不占用写路径，所以模型调用从不等待目录扫描；挂载时也会在后台先跑一遍，把上一轮运行遗留的超限记录清掉，而不拖慢第一次调用。被淘汰记录对应的会话指针会一并删除，读取方会报告索引不可用，而不是按指针去找已删除的文件。

## 最近请求索引

不可变 JSON 发布后，带 sessionId 的请求会在 .session-index-v1 更新按会话哈希命名的指针。该元数据索引是派生视图：索引失败会报告，但已完成的归档和模型调用继续执行。新增归档文件仅允许属主读取。

index-store 导出支持读取指针，并从明确指定的归档请求显式修复指针，不扫描历史正文。写入只在同一个 RequestArchiveIndex 实例内排序；维护性 seed 必须在归档索引写入器空闲时执行，因为独立进程不共享其写入队列。原始 JSON 保持不变。

Web context-inspector 通过带会话授权的 Remote 方法读取该索引。归档仍是服务商格式转换与附件解析前的框架输入，不能据此证明网络送达。
