/** Copy owned by the read-only context inspector. */
export declare const NS = "elysia-context-inspector";
export declare const zh: {
    readonly 'view.label': "上下文";
    readonly "metrics.title": "上下文统计";
    readonly "metrics.close": "关闭上下文统计";
    readonly "metrics.current": "当前文本 / 结构估算";
    readonly "metrics.trigger": "上下文估算 {tokens}";
    readonly "metrics.pending": "上下文统计尚未就绪";
    readonly "metrics.partial": "部分估算";
    readonly "metrics.invalid": "上下文估算数据不一致";
    readonly "metrics.capacityUnknown": "模型容量未知，暂不显示占用百分比。";
    readonly "metrics.additive": "系统 + 工具 + 消息 = 上方估算总量。";
    readonly "metrics.method.tokenizer": "本地参考分词器估算";
    readonly "metrics.method.heuristic": "加权字符估算";
    readonly "metrics.method.mixed": "分词与字符混合估算";
    readonly "metrics.estimateOnly": "估算包含消息结构开销；第三方服务、模型别名和实际请求封装可能有差异，不是 API 实报。";
    readonly "metrics.incomplete": "仅计可估算内容；附件或扩展块未完整计价，不包含完整图像等额外开销。";
    readonly "metrics.latest": "最近请求 API 实报输入";
    readonly "metrics.purpose.label": "实报来源";
    readonly "metrics.purpose.conversation": "普通对话";
    readonly "metrics.purpose.compaction": "压缩调用";
    readonly "metrics.purpose.unknown": "未知调用";
    readonly "metrics.noReport": "暂无 API 用量回报。";
    readonly "metrics.inputOnly": "包含未缓存输入、缓存读取与缓存写入；不含输出。";
    readonly "metrics.uncached": "未缓存输入";
    readonly "metrics.cacheRead": "缓存读取";
    readonly "metrics.cacheWrite": "缓存写入";
    readonly "metrics.unknown": "未知";
    readonly "metrics.relationship.same-context": "保留内容自实报后未变化；实际请求封装仍可能不同。";
    readonly "metrics.relationship.content-changed": "历史实报：输入已变化，不代表当前用量。";
    readonly "metrics.relationship.route-changed": "历史实报：模型或提供方已变化，不代表当前用量。";
    readonly "metrics.relationship.unknown": "实报与当前输入的对应关系尚未确认。";
    readonly "metrics.reportNotBreakdown": "API 实报是上次请求总量，不按估算比例拆成系统、工具或消息的精确用量。";
    readonly title: "完整提示词";
    readonly description: "所选会话最近归档的框架请求。归档不代表网络发送成功；这不是 HTTP 抓包，也不是下一轮预览。";
    readonly refresh: "刷新最近请求";
    readonly loading: "正在读取最近请求…";
    readonly empty: "此会话暂无请求归档。";
    readonly indexUnavailable: "请求归档索引当前不可用，无法确认最近请求。";
    readonly callKind: "调用来源";
    readonly agentLoop: "代理循环";
    readonly otherCall: "其他框架调用";
    readonly systemDescription: "包含请求的 system 字段，以及完整消息中所有 system / developer 消息（包括动态注入）。非文本内容按原结构保留。";
    readonly latestError: "无法读取此会话的请求归档。请检查连接和访问权限后重试。";
    readonly capturedAt: "归档时间";
    readonly model: "模型";
    readonly provider: "提供方";
    readonly requestId: "请求标识";
    readonly messagesCount: "消息";
    readonly toolsCount: "工具";
    readonly system: "系统提示词";
    readonly messages: "完整消息";
    readonly tools: "工具定义";
    readonly raw: "原始 JSON";
    readonly sections: "提示词内容";
    readonly displayMode: "显示方式";
    readonly readableText: "可读文本";
    readonly jsonStructure: "JSON 结构";
    readonly loaded: "已加载 {loaded} / {total} 字节";
    readonly partial: "当前只显示已加载部分，尚非全文。";
    readonly complete: "本节已完整加载";
    readonly loadMore: "继续加载";
    readonly loadAll: "加载全文";
    readonly cancel: "取消加载";
    readonly reading: "正在加载…";
    readonly readError: "本节读取未完成，已加载内容仍保留。可以继续重试。";
    readonly emptySection: "本节内容为空。";
    readonly content: "{section}内容";
};
export declare const en: Record<keyof typeof zh, string>;
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        'elysia-context-inspector': keyof typeof zh;
    }
}
//# sourceMappingURL=locales.d.ts.map