# D-1 只读勘察：旧爱莉桥接删除清单审计

> 状态：**只读勘察完成**。本轮**未删除、未移动、未重命名任何文件**，未修改任何源码，未执行任何 git 写操作。
> 勘察时间：2026-11-09 19:33–19:58（Asia/Shanghai）
> 基线 HEAD：Elysium `5aee3cf2` / Elysia-Harness `1f81e4e987` / Ayla `b4fc8ee`
> 事实源：`REQUIREMENTS.zh.md` §13、`DEVELOPMENT.zh.md` §2（D-1）
> 口径：**所有结论都附 `文件:行号` 证据**；未实测的推断单独标注为「推断（未实测）」，不写成结论。

---

## 0. 勘察口径与方法

| 项 | 内容 |
|---|---|
| 代码 grep 范围 | `Ayla/backend/{apps,config,tests,launcher.py}`，`--include=*.py`，排除 `__pycache__`、`.venv` |
| 前端 grep 范围 | `Ayla/web/src`、`Ayla/flutter/lib`（当前工作树 + `git show HEAD:` 基线） |
| 跨仓库 grep 范围 | `Elysia-Harness/plugins/*`、`Elysia-Harness/homes`、`Elysia-Harness/docs` |
| 服务器 | `ssh ayerelysia`（frp.volx.top:6020），**只读**：`ls` / `cat` / `grep` / `docker ps` / `docker logs` / `mysql -N -e SELECT` |
| 数据库 | 本地 MySQL `ayla`（dbhub `elysia` 源）+ 生产容器 `ayla-mysql`，**只读 SELECT** |
| 未做 | 任何写操作、任何 `git add/commit/checkout/stash/reset`、任何服务重启、任何配置改动 |

> ⚠️ 勘察期间发现**另一个 agent 正在并行撤下 Ayla 前端爱莉对接层**（`Ayla` 工作树 76 项改动，含删除 `web/src/api/elysia.ts` 等）。本报告所有前端结论都标注了「工作树当前值」与「HEAD 基线值」两套，见 §5-R1。

---

## 1. 概览表

### 1.1 文件级（§13 清单 + 勘察补全）

| # | 待删对象 | 类型 | 行数 | 命中数（backend .py） | 分类 | 处置 |
|---|---|---|---|---|---|---|
| F1 | `apps/elysia_bridge/elysia_client.py` | 文件 | 821 | 14（自身定义） | 随文件一起删 | 整文件删除 |
| F2 | `apps/elysia_bridge/inline.py` | 文件 | 312 | 35 | 随文件一起删 | 整文件删除 |
| F3 | `apps/elysia_bridge/voice_observer.py` | 文件 | 328 | 8 | 随文件一起删 | 整文件删除 |
| F4 | `apps/elysia_bridge/management/commands/run_bridge.py` | 文件 | 116 | 12 | 随文件一起删 | 整文件删除 |
| F5 | `apps/elysia_bridge/services.py` 的 SSE/凭据/投影/语音段 | 文件片段 | 1278 中 1135（82–1216 行） | 26 | 随文件一起删（片段） | 保留 1–81（含两个异常类）与 1247–1278，见 §1.3 |
| F6 | `tests/test_elysia_client.py` | 文件 | 467 | 22 | 随文件一起删 | 整文件删除 |
| F7 | `tests/test_bridge_loop.py` | 文件 | 592 | 7 | 随文件一起删 | 整文件删除 |
| F8 | `tests/test_outbound.py` | 文件 | 281 | 1 | 随文件一起删 | 整文件删除 |
| F9 | `tests/test_inline.py` | 文件 | 109 | 11 | 随文件一起删 | 整文件删除（**§13 未列，勘察补全**） |
| F10 | `tests/test_voice_observer.py` | 文件 | 341 | 25 | 随文件一起删 | 整文件删除（**§13 未列**） |
| F11 | `tests/test_voice_call_client.py` | 文件 | 419 | 10 | 随文件一起删 | 整文件删除（**§13 未列**） |
| F12 | `tests/test_voice_call_api.py` | 文件 | 203 | 1 | 随文件一起删 | 整文件删除（**§13 未列**） |
| F13 | `tests/test_voice_live_projection.py` | 文件 | 320 | 2 | 随文件一起删 | 整文件删除（**§13 未列**） |
| F14 | `tests/test_inject.py` | 文件 | 261 | 3 | **需要改**（部分保留） | 只保留「非爱莉会话不 inject / 爱莉本人不入站」这类语义，其余随旧 inject 删除；见 §3-C13 |

**整文件删除合计：12 个文件**（F1–F4 四个 + F6–F13 八个）+ 1 个片段删除（F5 `services.py`）+ 1 个文件重写（F14 `test_inject.py`）。

### 1.2 符号级

| 符号 | 类型 | backend .py 命中 | 文件数 | 分类 | 处置 |
|---|---|---|---|---|---|
| `ElysiaClient` | 类 | 55 | 9 | 随文件一起删 | 全部落在 F1–F5/F6–F13 内 |
| `elysia_client`（模块名） | 模块 | 18 | 12 | 随文件一起删 | 同上 |
| `run_bridge_loop` | 函数 | 24 | 7 | 随文件一起删 | 定义在 `services.py:1081` |
| `run_bridge`（含子串命中） | 命令/注释 | 44 | 9 | 随文件一起删 | 独立命中 20（44 − 24 个 `run_bridge_loop`） |
| `ElysiaCredentialManager` | 类 | 14 | 4 | 随文件一起删 | 定义在 `services.py:95` |
| `voice_observer`（模块名） | 模块 | 30 | 3 | 随文件一起删 | 3 个调用点在 `services.py` 语音段 |
| `start_inline_bridge` | 函数 | 7 | 3 | **需要改** | 2 个调用点在 `config/asgi.py` |
| `stop_inline_bridge` | 函数 | 4 | 2 | **需要改** | 2 个调用点在 `config/asgi.py` |
| `ELYSIA_BASE_URL` | 配置键 | 15 | 6 | **需要改** | 定义 `settings.py:267` |
| `ELYSIA_CREDENTIAL_FILE` | 配置键 | 8 | 5 | **需要改** | 定义 `settings.py:268` |
| `ELYSIA_SSE_`（前缀） | 配置键 ×2 | 4 | 1 | **需要改** | `settings.py:272-275` |
| `ELYSIA_BRIDGE_INLINE` | 配置键 | 12 | 5 | **需要改** | 定义 `settings.py:278` + `settings_test.py:34` |
| `stream_id` | 模型字段 | 165 | 20 | **混合**：多数随删，**2 处需要改** | 见 §2.4 |
| `platform` | 模型字段 | 35（bridge 内）+ 51（releases，无关） | — | **混合**：字段随删，`releases` 保留 | 见 §2.4 |
| `chat_type` | 模型字段 | 20 | 10 | 随文件一起删 + 1 处需要改 | 见 §2.4 |

### 1.3 必须保留（§13 明确保留，勘察确认有消费者）

| 对象 | 证据 | 说明 |
|---|---|---|
| `ElysiaProfile` 模型 | `apps/chat/services.py:148`、`apps/chat/tests/test_friend_private_send.py:14` | 保留 `user/enabled/display_name/created_at` |
| `ProfileNotConfigured` / `BridgeError` | `apps/elysia_bridge/views.py:25,126,146,150,152,158,160` | **必须留在 `services.py`**，否则 `views.py` 模块级 import 失败 |
| `broadcast_elysia_profile_updated` | `apps/elysia_bridge/views.py:89-91` | 与 SSE 无关，保留（`services.py:1254-1278`） |
| `views.py` profile 管理端点 | `apps/elysia_bridge/urls.py:7-16` | 语义改为「探测通道连通性」 |
| `apps/chat/services.py:find_global_by_idempotency_key` | `apps/chat/services.py:203` | 通用幂等查询，新 outbox/reply 落库仍会用到 |
| `apps/releases/*` 的 `platform` | `apps/releases/services.py:99-102` 等 | 客户端发布产物平台，**同名不同义** |
| `conscious-mind` 的 `ELYSIA_BASE_URL` | `Elysia-Harness/plugins/conscious-mind/src/tui.ts:48,60` | LLM provider base URL，**同名不同义，绝不能连带清理** |

---

## 2. 逐对象证据

### 2.1 文件级证据（行数 + 是否存在 + 是否被 git 跟踪）

```text
$ cd Ayla/backend && wc -l apps/elysia_bridge/*.py apps/elysia_bridge/management/commands/*.py apps/elysia_bridge/tests/*.py
  821 apps/elysia_bridge/elysia_client.py
  312 apps/elysia_bridge/inline.py
  328 apps/elysia_bridge/voice_observer.py
  116 apps/elysia_bridge/management/commands/run_bridge.py
 1278 apps/elysia_bridge/services.py
  467 apps/elysia_bridge/tests/test_elysia_client.py
  592 apps/elysia_bridge/tests/test_bridge_loop.py
  281 apps/elysia_bridge/tests/test_outbound.py
  109 apps/elysia_bridge/tests/test_inline.py
  341 apps/elysia_bridge/tests/test_voice_observer.py
  419 apps/elysia_bridge/tests/test_voice_call_client.py
  203 apps/elysia_bridge/tests/test_voice_call_api.py
  320 apps/elysia_bridge/tests/test_voice_live_projection.py
  261 apps/elysia_bridge/tests/test_inject.py
  114 apps/elysia_bridge/tests/test_models.py
  214 apps/elysia_bridge/tests/test_profile_api.py
```

> 与 §13 数字对照：`elysia_client.py` 821 行 ✅ 一致；`inline.py` 312 ✅；`voice_observer.py` 328 ✅。
> §13 说 `services.py` 中约 1000 行，实测应删区间为 **82–1216 行，共 1135 行**（保留 1–81 头部含 `BridgeError`/`ProfileNotConfigured`，保留 1247–1278 的 profile 广播），偏差 +13%。
> 另：`__all__`（`services.py:1220-1244`）列出 23 个导出名，删完只剩 3 个有效，**必须重写**（见 C23）。

全部 13 个待删文件均被 git 跟踪（`git ls-files backend/apps/elysia_bridge` 全量列出），删除会进 diff，可回滚。

### 2.2 符号级完整 grep（`Ayla/backend`，`--include=*.py`，排除 `__pycache__`）

#### `ElysiaClient`（55 命中 / 9 文件）

```text
apps/elysia_bridge/elysia_client.py:46:class ElysiaClientError(Exception):
apps/elysia_bridge/elysia_client.py:50:class ElysiaUnauthenticated(ElysiaClientError):
apps/elysia_bridge/elysia_client.py:54:class ElysiaTransportError(ElysiaClientError):
apps/elysia_bridge/elysia_client.py:58:class ElysiaHistoryGap(ElysiaClientError):
apps/elysia_bridge/elysia_client.py:267:def _extract_error(response: httpx.Response) -> ElysiaClientError:
apps/elysia_bridge/elysia_client.py:292:    return ElysiaClientError(f"Elysium API error {status}: {detail}")
apps/elysia_bridge/elysia_client.py:295:class ElysiaClient:
apps/elysia_bridge/elysia_client.py:322:    def __enter__(self) -> "ElysiaClient":
apps/elysia_bridge/elysia_client.py:744:                        raise ElysiaClientError(
apps/elysia_bridge/elysia_client.py:810:    "ElysiaClient",
apps/elysia_bridge/elysia_client.py:811:    "ElysiaClientError",
apps/elysia_bridge/inline.py:118:    from apps.elysia_bridge.elysia_client import ElysiaClient
apps/elysia_bridge/inline.py:135:    client = ElysiaClient(base_url=base_url)
apps/elysia_bridge/inline.py:238:        from apps.elysia_bridge.elysia_client import ElysiaClient
apps/elysia_bridge/inline.py:256:        client = ElysiaClient(base_url=base_url)
apps/elysia_bridge/management/commands/run_bridge.py:24:from apps.elysia_bridge.elysia_client import ElysiaClient
apps/elysia_bridge/management/commands/run_bridge.py:59:        client = ElysiaClient(base_url=base_url)
apps/elysia_bridge/services.py:40:    ElysiaClient,
apps/elysia_bridge/services.py:106:        client: ElysiaClient,
apps/elysia_bridge/services.py:476:    def __init__(self, *, client: ElysiaClient, credentials: ElysiaCredentialManager) -> None:
apps/elysia_bridge/services.py:565:                client = ElysiaClient(base_url=base_url)
apps/elysia_bridge/services.py:575:def _get_bridge() -> tuple[ElysiaClient, ElysiaCredentialManager]:
apps/elysia_bridge/services.py:1084:    client: ElysiaClient,
apps/elysia_bridge/tests/test_bridge_loop.py:13:用 fake ElysiaClient（记录 stream_sse 调用参数，按剧本产出事件/抛异常）。
apps/elysia_bridge/tests/test_elysia_client.py:23:    ElysiaClient,
apps/elysia_bridge/tests/test_elysia_client.py:52:def _client(handlers) -> ElysiaClient:
apps/elysia_bridge/tests/test_elysia_client.py:53:    return ElysiaClient(
apps/elysia_bridge/tests/test_elysia_client.py:84:    client = ElysiaClient(base_url=BASE, client=httpx.Client(transport=transport, base_url=BASE))
apps/elysia_bridge/tests/test_elysia_client.py:115:    client = ElysiaClient(base_url=BASE, client=httpx.Client(transport=transport, base_url=BASE))
apps/elysia_bridge/tests/test_elysia_client.py:135:    client = ElysiaClient(base_url=BASE, client=httpx.Client(transport=transport, base_url=BASE))
apps/elysia_bridge/tests/test_elysia_client.py:146:    client = ElysiaClient(base_url=BASE, client=httpx.Client(transport=transport, base_url=BASE))
apps/elysia_bridge/tests/test_elysia_client.py:158:    client = ElysiaClient(base_url=BASE, client=httpx.Client(transport=transport, base_url=BASE))
apps/elysia_bridge/tests/test_elysia_client.py:173:    client = ElysiaClient(base_url=BASE, client=httpx.Client(transport=transport, base_url=BASE))
apps/elysia_bridge/tests/test_elysia_client.py:202:    client = ElysiaClient(base_url=BASE, client=httpx.Client(transport=transport, base_url=BASE))
apps/elysia_bridge/tests/test_elysia_client.py:203:    with pytest.raises(elysia_client.ElysiaClientError) as exc:
apps/elysia_bridge/tests/test_elysia_client.py:219:    client = ElysiaClient(base_url=BASE, client=httpx.Client(transport=transport, base_url=BASE))
apps/elysia_bridge/tests/test_elysia_client.py:241:    client = ElysiaClient(base_url=BASE, client=httpx.Client(transport=transport, base_url=BASE))
apps/elysia_bridge/tests/test_elysia_client.py:307:def _sse_client(transport) -> ElysiaClient:
apps/elysia_bridge/tests/test_elysia_client.py:309:    return ElysiaClient(
apps/elysia_bridge/tests/test_elysia_client.py:431:    client = ElysiaClient(base_url=BASE, client=httpx.Client(transport=transport, base_url=BASE))
apps/elysia_bridge/tests/test_elysia_client.py:447:    client = ElysiaClient(base_url=BASE, client=httpx.Client(transport=transport, base_url=BASE))
apps/elysia_bridge/tests/test_elysia_client.py:460:    client = ElysiaClient(
apps/elysia_bridge/tests/test_inject.py:191:class _FakeElysiaClient:
apps/elysia_bridge/tests/test_inject.py:192:    """fake ElysiaClient：前 fail_times 次 inject 抛 401，之后返回 accepted。"""
apps/elysia_bridge/tests/test_inject.py:223:        client = _FakeElysiaClient(fail_times=fail_times)
apps/elysia_bridge/tests/test_voice_call_client.py:12:- 错误映射：404（call 不存在）/ 403（无 operate scope）→ ElysiaClientError 带 code；
apps/elysia_bridge/tests/test_voice_call_client.py:24:    ElysiaClient,
apps/elysia_bridge/tests/test_voice_call_client.py:25:    ElysiaClientError,
apps/elysia_bridge/tests/test_voice_call_client.py:56:def _client(transport: httpx.MockTransport) -> ElysiaClient:
apps/elysia_bridge/tests/test_voice_call_client.py:60:    return ElysiaClient(
apps/elysia_bridge/tests/test_voice_call_client.py:105:    client = ElysiaClient(
apps/elysia_bridge/tests/test_voice_call_client.py:375:    with pytest.raises(ElysiaClientError) as exc:
apps/elysia_bridge/tests/test_voice_call_client.py:389:    with pytest.raises(ElysiaClientError) as exc:
apps/elysia_bridge/voice_observer.py:153:    from .elysia_client import ElysiaClient
apps/elysia_bridge/voice_observer.py:157:    client = ElysiaClient(base_url=base_url)
```

**分类：全部「随文件一起删」。** 55 条命中无一落在保留文件（`chat/`、`accounts/`、`releases/` 等）中。

#### `elysia_client`（18 命中 / 12 文件）

```text
apps/elysia_bridge/elysia_client.py:2:elysia_client —— 阶段三 Elysium HTTP 客户端（REST + SSE 长连接）。
apps/elysia_bridge/inline.py:118:    from apps.elysia_bridge.elysia_client import ElysiaClient
apps/elysia_bridge/inline.py:238:        from apps.elysia_bridge.elysia_client import ElysiaClient
apps/elysia_bridge/management/commands/run_bridge.py:24:from apps.elysia_bridge.elysia_client import ElysiaClient
apps/elysia_bridge/services.py:38:from apps.elysia_bridge.elysia_client import (
apps/elysia_bridge/tests/test_bridge_loop.py:25:from apps.elysia_bridge.elysia_client import (
apps/elysia_bridge/tests/test_elysia_client.py:2:elysia_client 契约测试（8.1 清单第 2 项）—— 全部 mock httpx，不依赖真实 Elysium。
apps/elysia_bridge/tests/test_elysia_client.py:19:from apps.elysia_bridge import elysia_client
apps/elysia_bridge/tests/test_elysia_client.py:20:from apps.elysia_bridge.elysia_client import (
apps/elysia_bridge/tests/test_elysia_client.py:203:    with pytest.raises(elysia_client.ElysiaClientError) as exc:
apps/elysia_bridge/tests/test_outbound.py:30:from apps.elysia_bridge.elysia_client import EventEnvelope
apps/elysia_bridge/tests/test_voice_call_api.py:21:from apps.elysia_bridge.elysia_client import (
apps/elysia_bridge/tests/test_voice_call_client.py:15:全部走同步 httpx.MockTransport，不依赖真实 Elysium（与 test_elysia_client.py 同模式）。
apps/elysia_bridge/tests/test_voice_call_client.py:22:from apps.elysia_bridge.elysia_client import (
apps/elysia_bridge/tests/test_voice_live_projection.py:29:from apps.elysia_bridge.elysia_client import EventEnvelope, VoiceTranscriptEntry
apps/elysia_bridge/tests/test_voice_observer.py:24:from apps.elysia_bridge.elysia_client import VoiceCallStatus
apps/elysia_bridge/voice_observer.py:153:    from .elysia_client import ElysiaClient
apps/elysia_bridge/voice_observer.py:224:            from .elysia_client import VoiceTranscriptEntry
```

**分类：全部「随文件一起删」。** 注意 `services.py:38` 是**模块级 import**，删文件前必须先删这段，否则 `services` 模块整体 import 失败。

#### `run_bridge_loop`（24 命中 / 7 文件）

```text
apps/elysia_bridge/elysia_client.py:341:        `ElysiaTransportError`，让调用方（run_bridge_loop 等）能按
apps/elysia_bridge/elysia_client.py:758:            # ElysiaTransportError，交给 run_bridge_loop 的有界退避重连。
apps/elysia_bridge/inline.py:1:"""内嵌 SSE 出站投影 —— 在 Ayla 后端进程内运行 run_bridge_loop。
apps/elysia_bridge/inline.py:6:   daemon 线程跑 run_bridge_loop；进程退出时线程随之终止（SSE 断连，
apps/elysia_bridge/inline.py:18:  server 启动：记 warning 并跳过。Elysium 未运行由 run_bridge_loop 的
apps/elysia_bridge/inline.py:38:# 线程级自动重启退避（秒）：run_bridge_loop 的断线重连覆盖 Elysium 未运行/
apps/elysia_bridge/inline.py:96:    - run_bridge_loop 的断线重连负责"Elysium 未运行/重启窗口"的恢复；
apps/elysia_bridge/inline.py:104:            # run_bridge_loop 正常返回（未来显式停止场景）也短暂退避重启
apps/elysia_bridge/inline.py:117:    """单轮 bridge 运行：查询 profile → 建 client/credentials/loop → run_bridge_loop。"""
apps/elysia_bridge/inline.py:122:        run_bridge_loop,
apps/elysia_bridge/inline.py:150:            run_bridge_loop(
apps/elysia_bridge/inline.py:242:            run_bridge_loop,
apps/elysia_bridge/inline.py:265:                await run_bridge_loop(
apps/elysia_bridge/management/commands/run_bridge.py:14:真实订阅循环逻辑在 services.run_bridge_loop（供本命令与契约测试共用），
apps/elysia_bridge/management/commands/run_bridge.py:95:                services.run_bridge_loop(
apps/elysia_bridge/services.py:1081:async def run_bridge_loop(
apps/elysia_bridge/services.py:1241:    "run_bridge_loop",
apps/elysia_bridge/tests/test_bridge_loop.py:2:SSE 订阅循环契约测试（8.1 清单第 5~6 项）—— mock Elysium 流，验证 run_bridge_loop。
apps/elysia_bridge/tests/test_bridge_loop.py:172:        bridge_services.run_bridge_loop(
apps/elysia_bridge/tests/test_bridge_loop.py:382:        bridge_services.run_bridge_loop(
apps/elysia_bridge/tests/test_bridge_loop.py:481:        bridge_services.run_bridge_loop(
apps/elysia_bridge/tests/test_bridge_loop.py:569:    回归真实缺陷：裸 httpx.ConnectError 曾冒泡出 run_bridge_loop，在
apps/elysia_bridge/tests/test_elysia_client.py:424:    ElysiaTransportError，由 run_bridge_loop 有界退避处理（不刷完整 traceback）。
config/settings.py:276:# 内嵌出站投影：ASGI lifespan 启动时在 Ayla 后端进程内运行 run_bridge_loop
```

**分类：23 条「随文件一起删」+ 1 条「需要改」**（`config/settings.py:276` 是注释，随配置键删除）。

#### `run_bridge`（44 命中，含 `run_bridge_loop` 子串；独立命中 20）

独立命中（排除 `run_bridge_loop` 后）：

```text
apps/elysia_bridge/apps.py:10:        """后端进程启动时内嵌启动 SSE 出站投影（run_bridge，单实例文件锁）。"""
apps/elysia_bridge/inline.py:16:  等同旧方式：独立进程 `manage.py run_bridge`（命令保留）；
apps/elysia_bridge/management/commands/run_bridge.py:2:run_bridge —— 启动爱莉桥接 SSE 订阅后台循环（明确 owner，AGENTS.md §7）。
apps/elysia_bridge/management/commands/run_bridge.py:5:    python manage.py run_bridge [--stream STREAM_ID] [--no-daemon]
apps/elysia_bridge/services.py:2:elysia_bridge.services —— 爱莉桥接核心领域逻辑（供 REST / run_bridge 命令共用）。
apps/elysia_bridge/services.py:328:    """异步版：供 run_bridge（asyncio 事件循环）与 async 测试使用。
apps/elysia_bridge/services.py:408:    """异步向会话组广播（run_bridge / async 测试用），捕获 ChannelFull 不抛断。"""
apps/elysia_bridge/services.py:890:    """异步版：供 run_bridge（asyncio 事件循环）与 async 测试使用。
apps/elysia_bridge/services.py:955:# ---------- SSE 订阅循环（run_bridge 命令 / 测试共用） ----------
apps/elysia_bridge/tests/test_inline.py:89:    前两次 _run_bridge_once 抛异常（模拟 Elysium 重启瞬间连接错误击穿循环），
apps/elysia_bridge/tests/test_inline.py:103:    monkeypatch.setattr(inline, "_run_bridge_once", fake_run)
apps/elysia_bridge/tests/test_voice_live_projection.py:216:# ---------- run_bridge 事件分派（M4-5 §5.2 第 2/3 步，_handle_envelope） ----------
config/asgi.py:7:- lifespan -> 由外层包装器处理：startup 时启动内嵌 run_bridge（SSE 出站
config/settings.py:277:# （文件锁保证单实例）。关闭时需独立进程 `manage.py run_bridge`。
launcher.py:1:"""Ayla 后端一键启动器：runserver + 内嵌 SSE 出站投影（run_bridge）。
launcher.py:8:- 本启动器是 runserver 进程的 owner；run_bridge（SSE 出站投影）已内嵌到
launcher.py:25:    python manage.py run_bridge                             # 独立 bridge
```

**分类：14 条随删 + 3 条需要改**（`apps.py:10` 注释、`config/asgi.py:7` 文档串、`launcher.py:1/8/25` 文档串）。
**`launcher.py` 是保留文件**：只改注释，不改逻辑（它的 runserver owner / 迁移前置逻辑与桥接无关）。

#### `ElysiaCredentialManager`（14 命中 / 4 文件）

```text
apps/elysia_bridge/inline.py:121:        ElysiaCredentialManager,
apps/elysia_bridge/inline.py:136:    credentials = ElysiaCredentialManager(
apps/elysia_bridge/inline.py:241:            ElysiaCredentialManager,
apps/elysia_bridge/inline.py:257:        credentials = ElysiaCredentialManager(
apps/elysia_bridge/management/commands/run_bridge.py:27:    ElysiaCredentialManager,
apps/elysia_bridge/management/commands/run_bridge.py:60:        credentials = ElysiaCredentialManager(
apps/elysia_bridge/services.py:95:class ElysiaCredentialManager:
apps/elysia_bridge/services.py:476:    def __init__(self, *, client: ElysiaClient, credentials: ElysiaCredentialManager) -> None:
apps/elysia_bridge/services.py:566:                credentials = ElysiaCredentialManager(
apps/elysia_bridge/services.py:575:def _get_bridge() -> tuple[ElysiaClient, ElysiaCredentialManager]:
apps/elysia_bridge/services.py:1085:    credentials: ElysiaCredentialManager,
apps/elysia_bridge/services.py:1223:    "ElysiaCredentialManager",
apps/elysia_bridge/voice_observer.py:154:    from .services import ElysiaCredentialManager
apps/elysia_bridge/voice_observer.py:158:    credentials = ElysiaCredentialManager(
```

**分类：全部「随文件一起删」**（`services.py` 内 6 条全在被删片段 82–1216 内）。

#### `voice_observer`（30 命中 / 3 文件）

```text
apps/elysia_bridge/services.py:645:#   observer WS（`/api/v1/voice-calls/{call_id}/observe`，见 voice_observer.py），转写增量
apps/elysia_bridge/services.py:695:            from .voice_observer import ensure_observing
apps/elysia_bridge/services.py:713:        from .voice_observer import ensure_observing
apps/elysia_bridge/services.py:728:    from .voice_observer import stop_observing
apps/elysia_bridge/services.py:740:    事件源取舍（见本段 docstring）：实时转写走 observer WS（voice_observer.py），
apps/elysia_bridge/tests/test_voice_observer.py:2:voice_observer 契约测试 —— observer WS 事件 → 状态/投影广播（mock 依赖，不连真实 Elysium）。
apps/elysia_bridge/tests/test_voice_observer.py:23:from apps.elysia_bridge import voice_observer
apps/elysia_bridge/tests/test_voice_observer.py:82:        voice_observer._observer_ws_url("http://el:8000", "call-1", "tok1")
apps/elysia_bridge/tests/test_voice_observer.py:86:        voice_observer._observer_ws_url("https://el:8000/", "c2", "tok2")
apps/elysia_bridge/tests/test_voice_observer.py:102:        terminal = await voice_observer._handle_observer_frame(
（+ 后续 20 条均为 voice_observer.* 的测试调用，行号 122/153/188/196/210/235/254/272/284/322/324/329/332/333/334/338/339/340/341）
apps/elysia_bridge/voice_observer.py:2:voice_observer —— 爱莉 Voice Live 通话的 observer WS 订阅（事件驱动，替代前端 5s/10s 轮询）。
```

**分类：全部「随文件一起删」。** 3 个真实调用点全在 `services.py` 语音段（695/713/728），会随片段一起消失。

#### `start_inline_bridge` / `stop_inline_bridge`（7 + 4 命中）

```text
# start_inline_bridge
apps/elysia_bridge/inline.py:8:2. **ASGI lifespan**（`start_inline_bridge`/`stop_inline_bridge`，备用）：
apps/elysia_bridge/inline.py:221:async def start_inline_bridge() -> dict[str, Any] | None:
apps/elysia_bridge/tests/test_inline.py:6:- `ELYSIA_BRIDGE_INLINE=False`（settings_test 默认）时 start_inline_bridge 返回 None；
apps/elysia_bridge/tests/test_inline.py:57:def test_start_inline_bridge_disabled_returns_none(settings):
apps/elysia_bridge/tests/test_inline.py:61:    state = asyncio.run(inline.start_inline_bridge())
apps/elysia_bridge/config/asgi.py:55:                from apps.elysia_bridge.inline import start_inline_bridge
apps/elysia_bridge/config/asgi.py:57:                bridge_state = await start_inline_bridge()

# stop_inline_bridge
apps/elysia_bridge/inline.py:8:2. **ASGI lifespan**（`start_inline_bridge`/`stop_inline_bridge`，备用）：
apps/elysia_bridge/inline.py:294:async def stop_inline_bridge(state: dict[str, Any] | None) -> None:
apps/elysia_bridge/config/asgi.py:63:                from apps.elysia_bridge.inline import stop_inline_bridge
apps/elysia_bridge/config/asgi.py:65:                await stop_inline_bridge(bridge_state)
```

**分类：4 条随删（inline.py + test_inline.py）+ 4 条「需要改」（`config/asgi.py:55,57,63,65`）。**
`asgi.py` 的两个 import 都在函数体内，删 `inline.py` **不会**导致启动失败（会被 `except Exception` 吞掉并打一条 `lifespan startup: 内嵌 SSE 出站投影失败` 的 error 日志），但会留下永久噪音，必须改。

#### `config/asgi.py` 现状（必须改的根）

```text
 47:async def _lifespan_app(scope, receive, send) -> None:
 48:    """处理 lifespan scope：startup 启动内嵌 bridge，shutdown 优雅停止。"""
 53:        if message["type"] == "lifespan.startup":
 54:            try:
 55:                from apps.elysia_bridge.inline import start_inline_bridge
 57:                bridge_state = await start_inline_bridge()
 58:            except Exception:  # noqa: BLE001 - 初始化失败不阻塞 server 启动
 59:                logger.exception("lifespan startup: 内嵌 SSE 出站投影失败")
 63:                from apps.elysia_bridge.inline import stop_inline_bridge
 65:                await stop_inline_bridge(bridge_state)
 74:async def wrapped_application(scope, receive, send) -> None:
 76:    if scope["type"] == "lifespan":
 77:        await _lifespan_app(scope, receive, send)
 83:application_ = application  # 保留原引用便于测试/调试
 84:application = wrapped_application
```

### 2.3 配置键级证据

#### `config/settings.py:262-282`（定义处）

```text
262:# ---------- 爱莉桥接（M4-4） ----------
263:# ELYSIA_BASE_URL：阶段三 Elysium API 根地址（不含 /api/v1 前缀，客户端拼接）。
267:ELYSIA_BASE_URL = env.str("ELYSIA_BASE_URL", default="")
268:ELYSIA_CREDENTIAL_FILE = env.str(
270:    default=str(BASE_DIR / "runtime" / "elysia_credential.json"),
272:ELYSIA_SSE_RECONNECT_SECONDS = env.float("ELYSIA_SSE_RECONNECT_SECONDS", default=3.0)
273:ELYSIA_SSE_EVENT_TYPES = env.list(
274:    "ELYSIA_SSE_EVENT_TYPES", default=["chat.message"]
278:ELYSIA_BRIDGE_INLINE = env.bool("ELYSIA_BRIDGE_INLINE", default=True)
280:# 爱莉 Voice Live observer WS 订阅（事件驱动替代前端 5s/10s 轮询）：
282:VOICE_OBSERVER_ENABLED = env.bool("VOICE_OBSERVER_ENABLED", default=True)
```

**分类：`ELYSIA_*` 5 个键「需要改」（删除）；`VOICE_OBSERVER_ENABLED`（282 行）§13 未列但同为旧桥接遗物 —— 只有 `voice_observer.py:62` 读它，随语音删除后成死键。**

#### 逐键消费者（`--include=*.py`）

```text
### ELYSIA_BASE_URL            (15 命中 / 6 文件)
  4 apps/elysia_bridge/inline.py
  3 apps/elysia_bridge/management/commands/run_bridge.py
  2 apps/elysia_bridge/services.py          (561, 563)
  3 apps/elysia_bridge/tests/test_inline.py
  1 apps/elysia_bridge/voice_observer.py    (156)
  2 config/settings.py

### ELYSIA_CREDENTIAL_FILE      (8 命中 / 5 文件)
  2 apps/elysia_bridge/inline.py
  1 apps/elysia_bridge/management/commands/run_bridge.py
  1 apps/elysia_bridge/services.py          (564)
  1 apps/elysia_bridge/voice_observer.py    (160)
  3 config/settings.py

### ELYSIA_SSE_                 (4 命中 / 1 文件)
  4 config/settings.py                      (266, 272, 273, 274)
  ⚠️ 没有任何代码读取 settings.ELYSIA_SSE_RECONNECT_SECONDS / ELYSIA_SSE_EVENT_TYPES
     —— run_bridge_loop 用的是硬编码默认值 reconnect_seconds=3.0 与 services.SSE_EVENT_TYPES
     （services.py:71, 1086-1087）。即这两个键**早已是死配置**。

### ELYSIA_BRIDGE_INLINE       (12 命中 / 5 文件)
  3 apps/elysia_bridge/inline.py            (15, 52, 62)
  5 apps/elysia_bridge/tests/test_inline.py
  1 config/settings.py                      (278)
  1 config/settings_test.py                 (34)
  2 launcher.py                             (10, 24，注释)
```

#### `.env` 系列（配置键落地处）

```text
Ayla/backend/.env:31:# 爱莉桥接（M4-4）
Ayla/backend/.env:32:# ELYSIA_BASE_URL：阶段三 Elysium API 根地址，如 http://127.0.0.1:8000
Ayla/backend/.env:33:ELYSIA_BASE_URL=http://127.0.0.1:8000
Ayla/backend/.env:34:# service credential 一次性 secret 落盘路径（Git 忽略，不提交；重启用它重换 session）
Ayla/backend/.env:35:ELYSIA_CREDENTIAL_FILE=./runtime/elysia_credential.json
Ayla/backend/.env:36:# SSE 断线重连有界退避初始间隔（秒）
Ayla/backend/.env:37:ELYSIA_SSE_RECONNECT_SECONDS=3.0
Ayla/backend/.env:38:# SSE 订阅事件类型（前缀过滤，取 chat.message.*）
Ayla/backend/.env:39:ELYSIA_SSE_EVENT_TYPES=chat.message

Ayla/backend/.env.example:30-38  同上（值不同，ELYSIA_BASE_URL 为空）
Ayla/deploy/examples/backend.env.example:33-38  同上（值为服务器版 18000）
```

> `Ayla/backend/.env` **被 git 忽略**（`Ayla/backend/.gitignore:6:.env`，实测 `git check-ignore -v backend/.env` 命中），
> `.env.example` 与 `deploy/examples/backend.env.example` **被跟踪**（`git ls-files` 列出）。

### 2.4 模型字段级证据（`stream_id` / `platform` / `chat_type`）

#### 定义处 `apps/elysia_bridge/models.py:42-71`

```text
 45:    PLATFORM_DEFAULT = "ayla"
 46:    CHAT_TYPE_PRIVATE = "private"
 47:    CHAT_TYPE_GROUP = "group"
 48:    CHAT_TYPE_CHOICES = [
 60:    stream_id = models.CharField(
 61:        "Elysium stream_id", max_length=240, unique=True
 62:    )
 63:    platform = models.CharField(
 64:        "平台标识", max_length=64, default=PLATFORM_DEFAULT
 65:    )
 69:    chat_type = models.CharField(
 70:        "聊天类型", max_length=16, choices=CHAT_TYPE_CHOICES, default=CHAT_TYPE_PRIVATE
 71:    )
```

**关键：`stream_id` 是 `unique=True`、**无 default**、**非空**。这一点决定了迁移回退风险（§5-R10）。**

#### `stream_id`（165 命中 / 20 文件）—— 必须区分两种语义

| 语义 | 例子 | 处置 |
|---|---|---|
| A. `ElysiaProfile.stream_id`（要删的列） | `models.py:60-62`、`serializers.py:33-35,57-70`、`views.py:69,137`、`services.py:494-545`、`run_bridge.py:115` | 随字段/文件删，但**保留文件里的引用需要改** |
| B. Elysium 侧 stream 参数（HTTP 客户端内部） | `elysia_client.py` 全部、`voice_observer.py:164` | 随文件一起删 |

逐文件命中（`grep -w stream_id`）：

```text
 31 apps/elysia_bridge/services.py          ← A+B 混合，整段删除
 21 apps/elysia_bridge/tests/test_bridge_loop.py
 20 apps/elysia_bridge/tests/test_profile_api.py
 17 apps/elysia_bridge/tests/test_models.py
 13 apps/elysia_bridge/tests/test_elysia_client.py
 11 apps/elysia_bridge/serializers.py       ← 需要改
 11 apps/elysia_bridge/elysia_client.py
  6 apps/elysia_bridge/tests/test_voice_live_projection.py
  6 apps/elysia_bridge/models.py            ← 需要改
  5 apps/elysia_bridge/tests/test_inject.py
  4 apps/elysia_bridge/tests/test_outbound.py
  4 apps/elysia_bridge/management/commands/run_bridge.py
  3 apps/elysia_bridge/voice_observer.py
  3 apps/elysia_bridge/views.py             ← 需要改
  2 apps/elysia_bridge/tests/test_voice_observer.py
  2 apps/elysia_bridge/migrations/0003_migrate_legacy_ayla_profiles.py  ← 历史迁移，**不改**
  2 apps/elysia_bridge/inline.py
  2 apps/chat/tests/test_friend_private_send.py   ← 需要改（保留文件！）
  1 apps/elysia_bridge/tests/test_voice_call_api.py
  1 apps/elysia_bridge/migrations/0001_initial.py ← 历史迁移，**不改**
```

**`apps/chat/tests/test_friend_private_send.py` 是唯一落在「保留目录」的字段消费者**：

```text
 14:from apps.elysia_bridge.models import ElysiaProfile, generate_elysia_stream_id
 30:    ElysiaProfile.objects.create(
 31:        user=elysia,
 32:        stream_id=generate_elysia_stream_id(elysia.id),
 33:        enabled=True,
 34:    )
138:        ElysiaProfile.objects.create(
139:            user=elysia,
140:            stream_id=generate_elysia_stream_id(elysia.id),
```

→ 删字段后这里会 `TypeError: ElysiaProfile() got unexpected keyword argument 'stream_id'`，**§13 与 D-2 都没提**。见 §3-C12。

#### `platform`（bridge 内 35 命中；releases 51 命中为同名异义）

```text
# bridge 内（要删/要改）
apps/elysia_bridge/models.py:45,63-65
apps/elysia_bridge/serializers.py:44          ← 需要改（fields 列表）
apps/elysia_bridge/services.py:7,57,528       ← 528 行 platform=profile.platform 在 inject 里
apps/elysia_bridge/views.py:7                 ← 文档串
apps/elysia_bridge/elysia_client.py:436,441,448
apps/elysia_bridge/migrations/0001_initial.py:22 / 0002:15 / 0003:20-23

# releases 内（同名异义，保留）
apps/releases/services.py:30,99-102,181-183,206,256-258,347-348,359-366,380-392,412
apps/releases/views.py:6 处
apps/releases/management/commands/release_manifest_check.py:17,27,29
apps/releases/tests/test_api.py:22,57,77
apps/releases/tests/test_services.py:11 处
```

**分类：bridge 内「随删 + 1 处需要改（serializers.py:44）」；releases 内「保留」。**

#### `chat_type`（20 命中 / 10 文件，全在 bridge 内）

```text
  4 apps/elysia_bridge/tests/test_inject.py
  3 apps/elysia_bridge/tests/test_profile_api.py
  2 apps/elysia_bridge/tests/test_models.py
  2 apps/elysia_bridge/tests/test_elysia_client.py
  2 apps/elysia_bridge/serializers.py        ← 需要改（fields 列表 + 文档串）
  2 apps/elysia_bridge/models.py             ← 需要改
  2 apps/elysia_bridge/elysia_client.py      (435, 447)
  1 apps/elysia_bridge/views.py              ← 文档串
  1 apps/elysia_bridge/services.py           (527, inject 参数)
  1 apps/elysia_bridge/migrations/0001_initial.py
```

**分类：随文件一起删 + 3 处需要改。** `Message.chat_type` 不存在（`apps/chat/models.py` 无此字段），无同名混淆。

### 2.5 跨仓库证据（B）

对 §13 全部符号 + 模块名，逐符号 grep `Elysia-Harness/plugins`、`homes`、`docs`：

| 插件 | 命中数 | 说明 |
|---|---|---|
| `kook-bot` | **0** | — |
| `qq-napcat` | **0** | — |
| `feishu-app` | **0** | — |
| `conscious-mind` | **0**（对上述符号） | 但有 `ELYSIA_BASE_URL` 同名异义，见下 |
| `subconscious` | **0** | — |
| `request-archive` | **0** | — |
| `ayla-app` | 13 | **全部是文档自身的引用**（`DEVELOPMENT.zh.md` 第 34/37/39/41/56 行、`REQUIREMENTS.zh.md` 第 282-292 行），无代码 |

结论：**跨仓库零代码消费者，预期成立，已证明。**

```text
$ grep -rn -F "ElysiaClient" Elysia-Harness/plugins
./ayla-app/DEVELOPMENT.zh.md:34:   grep -rn "elysia_client|ElysiaClient|run_bridge|..." Ayla/backend --include=*.py

$ grep -rn -F "ELYSIA_BASE_URL" Elysia-Harness/plugins
./ayla-app/DEVELOPMENT.zh.md:41:4. `config/settings.py`：删除 `ELYSIA_BASE_URL`、...
./conscious-mind/README.md:219:...`ELYSIA_BASE_URL`, `ELYSIA_API_KEY`, `ELYSIA_MODEL`, or `--base-url`...
./conscious-mind/README.zh.md:265:...可以用 `ELYSIA_BASE_URL`、`ELYSIA_API_KEY`、`ELYSIA_MODEL`...
./conscious-mind/src/tui.ts:48:  let baseURL = process.env.ELYSIA_BASE_URL
./conscious-mind/src/tui.ts:60:          `set ELYSIA_BASE_URL and ELYSIA_API_KEY, or keep ${MODELS_TOML} readable...
```

⚠️ **`conscious-mind/src/tui.ts:48,60` 的 `ELYSIA_BASE_URL` 是 LLM provider base URL，与 Ayla 桥接无关。清理时若按字符串全局替换，会误伤 conscious-mind。** 这是本轮唯一需要显式保护的跨仓库同名项。

`homes/` 中的 `ELYSIA_*`（`homes/tui/profiles/dsh-tui/cordis.patch.yml:11,24,26,31,33,38,40,46`）全部是 `@elysia/*` 插件的环境变量前缀，与桥接无关，保留。

### 2.6 服务器侧证据（C，只读）

服务器：`ayerelysia@frp.volx.top:6020`，路径 `/home/ayerelysia/Elysia/ayla-deploy`。

#### `backend/.env`（容器 `env_file`，**含桥接 5 键 + 1 个语音键**）

```text
# 爱莉桥接（连服务器本机 Elysium，18000 只监听 127.0.0.1）
29:ELYSIA_BASE_URL=http://127.0.0.1:18000
30:ELYSIA_CREDENTIAL_FILE=/app/runtime/elysia_credential.json
31:ELYSIA_SSE_RECONNECT_SECONDS=3.0
32:ELYSIA_SSE_EVENT_TYPES=chat.message
33:ELYSIA_BRIDGE_INLINE=true
...
65:VOICE_OBSERVER_ENABLED=true
```

#### `docker-compose.yml`

```text
112:  # Ayla Django 后端：host 网络（连 Elysium 127.0.0.1:18000），daphne 绑 127.0.0.1:8100。
119:    env_file:
120:      - ./backend/.env
```

→ **compose 文件本身没有任何 `ELYSIA_*` / `elysia_bridge` / `run_bridge` 字面量**，桥接配置完全通过 `env_file` 注入。删键只需改 `backend/.env`，**不必改 compose**。

#### `nginx/nginx.conf`

```text
 5:#   2. 反代 /api/ /ws/ -> backend 127.0.0.1:8100（host 网络直连）
14:    server 127.0.0.1:8100;
```

→ 只有端口，**无桥接路径 / 无 `/events/stream` / 无 SSE 相关配置**。

#### 生产运行时事实（证明旧桥接早已空转）

```text
$ docker ps --format '{{.Names}}' | grep ayla
ayla-backend / ayla-nginx / ayla-livekit / ayla-srs / ayla-minio / ayla-mysql / ayla-redis

$ docker exec ayla-backend ls -la /app/runtime
-rwxr-xr-x 1 root root      1 Sep 10 15:57 elysia_bridge.lock
-rw-r--r-- 1 root root  16205 Oct 29 09:30 media-cleanup-backup-20261029-173024.json
-rw-r--r-- 1 root root  16205 Oct 29 09:32 media-cleanup-backup-20261029-173202.json
drwxr-xr-x 2 root root   4096 Sep 10 15:57 media_tmp
   ⚠️ 没有 elysia_credential.json —— 凭据从未落盘

$ docker logs --tail 400 ayla-backend | grep -i elysia
WARNING 2026-11-09 19:41:43,897 apps.elysia_bridge.inline 内嵌 SSE 出站投影跳过：未找到启用的爱莉 profile
ERROR   2026-11-09 19:41:43,897 apps.elysia_bridge.inline 内嵌 SSE 出站投影异常退出，60.0s 后自动重启
  File "/app/apps/elysia_bridge/inline.py", line 103, in _bridge_thread_main
  File "/app/apps/elysia_bridge/inline.py", line 132, in _run_bridge_once
RuntimeError: no enabled elysia profile
   （每 60 秒重复一次，最近 4 分钟连续 4 次）
```

→ **生产环境旧桥接线程正在按 60s 周期空转并打 ERROR + traceback**，正是 REQUIREMENTS §12.2 验收项「启动日志不再出现 `no enabled elysia profile`」要消除的对象。这条证据同时说明：删除 `inline.py` 有即时收益（消除日志噪音），且当前**没有任何真实桥接流量会受影响**。

#### 生产数据库（只读 SELECT）

```text
$ docker exec ... ayla-mysql mysql -uroot -N -e "SELECT COUNT(*) FROM ayla.elysia_profiles;"
rows    0
$ ... "SELECT name FROM ayla.django_migrations WHERE app='elysia_bridge'"
0001_initial
0002_ayla_platform_default
0003_migrate_legacy_ayla_profiles
```

→ **生产表 0 行，§13「表内 0 行」在生产成立**；迁移已到 0003，与 D-2 描述一致。

⚠️ **但本地开发库不是 0 行**：

```text
$ dbhub(elysia) SELECT id, platform, chat_type, enabled, display_name, created_at FROM ayla.elysia_profiles
id=1  platform=ayla  chat_type=private  enabled=1  display_name=爱莉  created_at=2026-08-10T20:51:39.239Z
（列结构：id, stream_id, platform, enabled, display_name, chat_type, created_at, user_id）
```

→ 见 §5-R2 与 §5-R10。

---

## 3. 「需要改」详细清单

判定标准：**删掉待删对象后，该位置会 import 失败、启动失败、运行报错、或产生永久噪音/死配置。**

| # | 位置 | 现状证据 | 为什么会破 | 要改成什么 | 严重度 |
|---|---|---|---|---|---|
| C1 | `apps/elysia_bridge/apps.py:9-13` | `ready()` → `from apps.elysia_bridge.inline import start_bridge_thread` → `start_bridge_thread()` | 删 `inline.py` 后 `django.setup()` 阶段 **ModuleNotFoundError**，**整个后端起不来**（`manage.py check` 也会挂） | 删除整个 `ready()` 方法（`AppConfig` 保留 `name`/`verbose_name`） | 🔴 阻断启动 |
| C2 | `apps/elysia_bridge/serializers.py:17` | `from .models import ElysiaProfile, generate_elysia_stream_id` | 若按 §13「`generate_elysia_stream_id` 之外的领域模型代码」字面执行（= 删该函数），**模块级 import 失败 → `urls.py` → 整个 URLconf 挂 → 全站 500** | 二者择一：① 保留 `generate_elysia_stream_id`（但已无字段可写，成死函数）；② 删函数 + 同步删 `serializers.py:17,57-70` 的自动生成逻辑与 `stream_id` 字段 | 🔴 阻断启动 |
| C3 | `apps/elysia_bridge/models.py:28-39,45-51,60-71` | 字段定义 + 常量 | 只写迁移不改模型 → `makemigrations` 报未同步；模型仍读已删列 → `OperationalError: Unknown column` | 删 `stream_id`/`platform`/`chat_type` 三字段 + `PLATFORM_DEFAULT`/`CHAT_TYPE_*` 四常量；新增 `0004` 迁移（`RemoveField`×3） | 🔴 运行时 500 |
| C4 | `apps/elysia_bridge/views.py:100-138`（`ElysiaProfileTestView`） | `:122 from .services import get_injector` / `:125 injector.smoke(profile=profile)` / `:137 {"ok": True, "stream_id": profile.stream_id, ...}` | `get_injector` 随服务层删除 → 冒烟端点 500；`:137` 读已删字段 | 改为探测通道连通性（D-4 契约：`GET /api/v1/elysia/bridge/health/` 或复用本端点），响应体去掉 `stream_id` | 🟠 端点 500 |
| C5 | `apps/elysia_bridge/views.py:141-306`（`ElysiaVoiceCall*` 5 个视图 + 3 个 helper） | `:170,201,215,241,261` 调用 `services.ensure_elysia_voice_call / get_voice_call_status / send_voice_text / end_elysia_voice_call / poll_voice_transcripts`；`:280,299` 读 `VoiceCallStatus/VoiceCallTicket` 属性 | 服务层语音函数删除后 → `AttributeError` → 每次调用 502；`_voice_error` 依赖 `ProfileNotConfigured` | **整段删除**（§13 未列，勘察补全） | 🟠 端点 502 |
| C6 | `apps/elysia_bridge/urls.py:17-42` | `voice-calls/`、`<call_id>/`、`/text/`、`/end/`、`/poll/` 五条路由 | 指向 C5 的视图 | 删除这 5 条 `path()` | 🟠 |
| C7 | `apps/chat/views.py:615-622` | `:618 from apps.elysia_bridge.services import on_user_message_to_elysia` → `:620 on_user_message_to_elysia(...)` | 旧 inject 函数删除后 **每次发消息都抛异常**（被 `except` 吞掉 → 只打 `elysia bridge inject failed` 日志）。用户消息不丢，但入站链路彻底断 | 换成新 outbox 写入（D-2/D-3 契约：与消息落库同事务写 `AylaInboundOutbox`）；在 D-3 完成前可先整段删除并保留 TODO | 🟠 功能断链 |
| C8 | `apps/elysia_bridge/services.py:74-79`（`BridgeError`/`ProfileNotConfigured`） | `views.py:25` **模块级** import `ProfileNotConfigured` | 若把 `services.py` 清空 → `views.py` import 失败 → URLconf 挂 | 保留这两个异常类（以及 `services.py` 的模块骨架）；或把异常迁到 `apps/elysia_bridge/exceptions.py` 并改 `views.py:25,146,158` | 🔴 阻断启动 |
| C9 | `config/asgi.py:47-84` | `_lifespan_app` / `wrapped_application` / `application_` / `application = wrapped_application` | 删 `inline.py` 后 import 被 `except` 吞掉，每进程启动打一条 error traceback | 删除 `_lifespan_app`、`wrapped_application`、`application_`，恢复 `application = ProtocolTypeRouter({...})` 直接暴露；同步删模块 docstring 第 7-10 行 | 🟠 启动噪音 |
| C10 | `config/settings.py:262-282` | 5 个 `ELYSIA_*` 键 + `VOICE_OBSERVER_ENABLED` | 删代码后成死配置；若保留会误导下一个人 | 删 `ELYSIA_BASE_URL/ELYSIA_CREDENTIAL_FILE/ELYSIA_SSE_RECONNECT_SECONDS/ELYSIA_SSE_EVENT_TYPES/ELYSIA_BRIDGE_INLINE`；`VOICE_OBSERVER_ENABLED` 同删（§13 未列） | 🟡 死配置 |
| C11 | `config/settings_test.py:33-34` | `# 测试环境不内嵌启动 SSE 出站投影` / `ELYSIA_BRIDGE_INLINE = False` | 键删除后该行指向不存在的键（无害但脏） | 删除这两行 | 🟡 |
| C12 | `apps/chat/tests/test_friend_private_send.py:14,30-34,138-142` | `from apps.elysia_bridge.models import ElysiaProfile, generate_elysia_stream_id`；`ElysiaProfile.objects.create(user=..., stream_id=generate_elysia_stream_id(...), enabled=True)` | 删字段后 **TypeError**；删函数后 **ImportError**。这是 `apps/chat` 下唯一受影响测试（该测试验的是「爱莉私聊免好友校验」，属保留功能） | 改为 `ElysiaProfile.objects.create(user=elysia, enabled=True)`，删 `generate_elysia_stream_id` import | 🔴 测试红 |
| C13 | `apps/elysia_bridge/tests/test_inject.py`（261 行） | `:20-26` import `InboundInjector / ProfileNotConfigured / on_user_message_to_elysia`；`:71,141` monkeypatch `get_injector`；`:191-226` fake client/credential | 整文件测的是旧 inject 路径，服务层删除后 **collection error**（import 阶段） | 拆：保留「非爱莉会话不触发」「爱莉本人不入站」两条语义（改写成 outbox 断言），删除 401 恢复 / fake injector 部分 | 🔴 测试红 |
| C13a | `apps/elysia_bridge/tests/test_inject.py:172-174` | `import apps.chat.views as chat_views` / `chat_views.on_user_message_to_elysia = _boom` | **该 monkeypatch 实际无效**：`chat/views.py:618` 是**函数内** import（`grep "^from apps.elysia_bridge" apps/chat/views.py` 零命中），模块级根本没有该属性，赋值只是给模块挂了个没人读的新属性。测试「201 通过」是因为真实 `on_user_message_to_elysia` 在 settings_test 下抛 `ProfileNotConfigured` 被 `except` 吞掉 —— **通过的原因与被测行为无关** | 重写该用例：直接断言 outbox 写入（正路）或断言异常被吞（反路），不要用无效 monkeypatch | 🟠 测试假绿 |
| C14 | `apps/elysia_bridge/tests/test_models.py:35,37,39,44-48,50-57,59-67,78-83` | `assert p.platform == ElysiaProfile.PLATFORM_DEFAULT`、`assert p.chat_type == ...`、`_make_profile(user, stream_id=...)`、`test_unique_stream_id` | 字段/常量删除后 **AttributeError / TypeError** | 删这三类断言与 `stream_id` 唯一性用例；保留 `user` 唯一、`enabled`、`display_name` 用例 | 🔴 测试红 |
| C15 | `apps/elysia_bridge/tests/test_profile_api.py`（20 处 `stream_id`） | `:45,49,58,68,80-82,87,90-91,93-110,116,121,130,140-141,147,170,182,201,208,214` | 删字段后 **TypeError**；`:185-214` 冒烟测试依赖 `get_injector` | 删 `stream_id/platform/chat_type` 相关断言与 `test_admin_init_without_stream_id_auto_generates_ayla_stream`；冒烟测试改为新探测契约 | 🔴 测试红 |
| C16 | `apps/chat/consumers.py:147-150,179,615-624` | `:150 group_add("elysia_voice")` / `:179 group_discard` / `:615-624 elysia_voice_call_status / elysia_voice_projected` | 语音删除后这两个 handler 永远收不到事件（死代码），且 `elysia_voice` 组让每个 WS 连接多占一个 group 成员 | 删除 147-150、179、615-624；`elysia_reply`（`:395-412`）**保留**（新 reply 帧仍会用到） | 🟡 死代码 |
| C17 | `launcher.py:1,8-10,22-25` | 文档串 `run_bridge`/`ELYSIA_BRIDGE_INLINE` | 只是注释，不影响运行 | 改注释：去掉内嵌 bridge 描述，保留 runserver owner / 迁移前置逻辑 | 🟡 文档 |
| C18 | `Ayla/backend/.env:31-39`、`.env.example:30-38`、`Ayla/deploy/examples/backend.env.example:33-38` | 见 §2.3 | 死键 | 删除这 5 个键 + 注释块 | 🟡 |
| C19 | `Ayla/backend/README.md`（70-76、94-103、124、151-172、214-217、255-258、443-461、472） | 多处描述 SSE 出站/凭据/`run_bridge`/环境变量表 | 文档与实现不符 | 按 D-9 回填：删旧描述，写新 WS 通道 | 🟡 文档 |
| C20 | `Ayla/start_ayla.bat:2` | `rem ... + run_bridge（SSE 出站投影）` | 注释 | 改注释 | 🟢 |
| C21 | `Ayla/web/scripts/e2e_elysia_chat.mjs`（5305 B） | `:2 M5-2 爱莉真实对话验收（... + run_bridge）`；整脚本驱动旧链路 | 旧链路删除后脚本必然失败 | 标记废弃或删除（前端侧由并行 agent 负责，见 R1） | 🟢 |
| C22 | `Ayla/backend/pyproject.toml:18-19` | `"websockets>=14.2"`，注释「爱莉 Voice Live observer WS 订阅」 | 全仓唯一使用者是 `voice_observer.py:151`（已确认） | 可删依赖；`httpx` **必须保留**（`apps/live/srs.py:43,47` 仍用） | 🟢 可选 |
| C23 | `apps/elysia_bridge/services.py:1220-1244`（`__all__`） | 23 个导出名，含 `ElysiaCredentialManager`/`run_bridge_loop`/`aproject_elysia_reply`/`create_elysia_voice_call` 等 | 删完函数后 `__all__` 仍列出不存在名字（`from ... import *` 会 `AttributeError`，静态检查也会报） | 重写为只保留 `BridgeError`/`ProfileNotConfigured`/`broadcast_elysia_profile_updated`（+ 新 outbox 相关） | 🟠 静态错误 |

**统计：24 条「需要改」，其中 🔴 阻断级 8 条（C1/C2/C3/C8/C12/C13/C14/C15）、🟠 功能/测试级 7 条（C4/C5/C6/C7/C9/C13a/C23）、🟡 配置/文档 7 条（C10/C11/C16/C17/C18/C19/C20）、🟢 可选 2 条（C21/C22）。**

---

## 4. 删除顺序建议（先叶子、后根）

> 每一步都给出「之后该跑什么」。命令均按 `Ayla/backend` 为工作目录；测试统一 `--ds=config.settings_test_mysql`（本仓库无 pytest-cov，**不要加 `--no-cov`**）。

### S0 基线（不改任何文件）

```bash
cd Ayla && git status --porcelain | wc -l && git rev-parse HEAD
cd backend && ./.venv/Scripts/python.exe -m pytest apps/elysia_bridge -q --ds=config.settings_test_mysql
./.venv/Scripts/python.exe manage.py check
```
记录基线用例数与失败数（历史记录显示 `test_outbound.py` 有既有遗留失败，见 `.workbuddy/memory/2026-08-11.md:28`，**基线可能不是全绿**）。

### S1 删「纯叶子」测试（F6–F13，共 8 个文件）

删除：`test_elysia_client.py`、`test_bridge_loop.py`、`test_outbound.py`、`test_inline.py`、`test_voice_observer.py`、`test_voice_call_client.py`、`test_voice_call_api.py`、`test_voice_live_projection.py`
（`test_inject.py` 属 F14，**不在本步删**，见 S4。）

```bash
./.venv/Scripts/python.exe -m pytest apps/elysia_bridge -q --ds=config.settings_test_mysql --co   # 收集应无 error
./.venv/Scripts/python.exe -m pytest apps/elysia_bridge -q --ds=config.settings_test_mysql
```
预期：剩余 `test_inject.py`/`test_models.py`/`test_profile_api.py` 仍全绿（此时实现未删）。

### S2 删语音域（叶子 → 根）

顺序：`voice_observer.py` → `services.py` 语音段（573–1078）→ `views.py:141-306` → `urls.py:17-42` → `chat/consumers.py:147-150,179,615-624`

```bash
./.venv/Scripts/python.exe -m pytest apps/chat apps/voice apps/elysia_bridge -q --ds=config.settings_test_mysql
./.venv/Scripts/python.exe manage.py check
```
注意：此时 `services.py` 仍 import `elysia_client`（第 38 行），**不能先删 `elysia_client.py`**。

### S3 删 SSE 入口链（命令 → 线程 → 服务循环）

顺序：`management/commands/run_bridge.py` → `inline.py` → `apps.py` 的 `ready()`（C1，**必须在删 inline.py 的同一个提交里**）→ `services.py:1081-1216 run_bridge_loop`

```bash
./.venv/Scripts/python.exe manage.py check          # 必须 0 issue
./.venv/Scripts/python.exe manage.py help | grep run_bridge   # 应无输出
```

### S4 删 HTTP 客户端 + 凭据/投影段

顺序：`services.py:82-211`（凭据）→ `213-439`（出站投影）→ `442-571`（inject + get_injector）→ 最后删 `elysia_client.py` + `services.py:38-49` import 块

⚠️ **同一步必须处理 C7（`chat/views.py:615-622`）与 C13（`test_inject.py`）**，否则 `manage.py check` 通过但发消息会刷异常。

```bash
./.venv/Scripts/python.exe manage.py check
./.venv/Scripts/python.exe -m pytest apps/chat -q --ds=config.settings_test_mysql
```

### S5 改接线（配置 + ASGI）

顺序：`config/asgi.py`（C9）→ `config/settings.py`（C10）→ `config/settings_test.py`（C11）→ `.env`/`.env.example`/`deploy/examples/backend.env.example`（C18）→ `launcher.py` 注释（C17）

```bash
./.venv/Scripts/python.exe manage.py check
./.venv/Scripts/python.exe -c "import os;os.environ['DJANGO_SETTINGS_MODULE']='config.settings';import django;django.setup();import config.asgi as a;print(type(a.application).__name__)"
# 期望输出 ProtocolTypeRouter（而不是 wrapped_application）
./.venv/Scripts/python.exe manage.py runserver 127.0.0.1:8100 --noreload   # 另开终端 curl /api/v1/health/
```

### S6 模型收敛（最后动 DB）

顺序：`models.py`（C3）→ `serializers.py`（C2）→ `views.py` 冒烟（C4）→ `test_models.py`/`test_profile_api.py`/`test_friend_private_send.py`（C12/C14/C15）→ 新增 `0004_remove_profile_bridge_fields.py`

```bash
./.venv/Scripts/python.exe manage.py makemigrations --check --dry-run   # 应报「No changes detected」
./.venv/Scripts/python.exe manage.py migrate elysia_bridge 0004
./.venv/Scripts/python.exe manage.py migrate elysia_bridge 0003        # 回退验证（见 R10，本地库有 1 行，可能失败）
./.venv/Scripts/python.exe manage.py migrate elysia_bridge 0004
./.venv/Scripts/python.exe -m pytest apps/elysia_bridge apps/chat -q --ds=config.settings_test_mysql
```

### S7 全仓复核 + 文档回填

```bash
cd Ayla/backend
grep -rn "elysia_client|ElysiaClient|run_bridge|ElysiaCredentialManager|voice_observer|start_inline_bridge|stop_inline_bridge|ELYSIA_BASE_URL|ELYSIA_CREDENTIAL_FILE|ELYSIA_SSE_|ELYSIA_BRIDGE_INLINE" apps config tests launcher.py --include="*.py" | grep -v __pycache__
# 期望：空
```
> 验收口径必须是「`*.py` + 配置」，**不能**用「全仓零命中」——见 R5。

---

## 5. 风险与阻塞

### R1 🔴 并行 agent 正在改 Ayla 前端（阻塞协作，不阻塞勘察）

勘察期间（19:33→19:58）`Ayla` 工作树出现 **76 项未提交改动**，其中含删除：

```text
 D web/src/api/elysia.ts
 D web/src/components/chat/ElysiaEntry.tsx
 D web/src/components/voice/ElysiaVoicePanel.tsx
 D web/src/hooks/useElysiaVoice.ts
 D web/src/vitest/use-elysia-voice.test.tsx
 D flutter/lib/core/api/elysia_api.dart
 D flutter/lib/core/models/elysia_profile.dart
 D flutter/lib/widgets/chat/elysia_entry.dart
 D flutter/lib/widgets/voice/elysia_voice_panel.dart
 M web/src/api/types.ts        （ElysiaProfile 接口已删）
 M web/src/ws/chat.ts          （elysia.reply 分支已删）
?? docs/plans/爱莉前端对接层撤下清单.md
```

后果：
1. **本报告所有前端结论都必须区分「HEAD」与「工作树当前值」**。例如 `web/src/api/types.ts:452-461` 的 `ElysiaProfile`（含 `stream_id/platform/chat_type`）**只在 HEAD 存在**，工作树已无。
2. 后端若与前端同批提交，会产生**跨仓库半删除状态**（后端仍返回 `stream_id`，前端已不读 —— 这本身安全；但反之删前端 API 而后端路由仍在则 404）。
3. 我**未**触碰任何前端文件；D-1 只动后端。

### R2 🟠 §13「表内 0 行」只对生产成立

| 库 | `elysia_profiles` 行数 | 证据 |
|---|---|---|
| 生产 `ayla-mysql` | **0** | `SELECT COUNT(*) FROM ayla.elysia_profiles` → `rows 0` |
| 本地开发 MySQL `ayla` | **1**（id=1, platform=ayla, chat_type=private） | dbhub SELECT |

影响：`RemoveField` 本身不因行数失败，但**「0 行所以可以随便删」的前提在本机不成立**；本地那 1 行的 `stream_id` 值会永久丢失（不可回滚，因为无 default）。

### R3 🟠 §13「stream_id / platform / chat_type 无消费者」与证据不符

- 后端消费者（保留文件中）：`serializers.py:33-35,44,47,57-70`、`views.py:69-70,137`、`apps/chat/tests/test_friend_private_send.py:14,30-34,138-142`
- 前端（HEAD）：`web/src/api/types.ts:452-461` 声明但**无字段读取**（`git grep ".stream_id" HEAD -- web/src` 零命中）；Flutter `elysia_profile.dart:64-66` 解析 `streamId/platform/chatType`，但**无任何读取点**（仅 `this.streamId` 构造器赋值）

结论：**「可删」成立，「无消费者」不成立** —— 必须同步改 3 个后端位置 + 2 个测试文件，不能只写迁移。

### R4 🟠 §13 清单遗漏 6 类连带对象

| 遗漏项 | 证据 |
|---|---|
| `views.py` 的 `ElysiaVoiceCall*` 5 视图 + 3 helper | `views.py:141-306` |
| `urls.py` 的 5 条 `voice-calls` 路由 | `urls.py:17-42` |
| `chat/consumers.py` 的 `elysia_voice` 组 + 2 handler | `consumers.py:150,179,615-624` |
| `settings.VOICE_OBSERVER_ENABLED` | `settings.py:282`、生产 `backend/.env:65=true` |
| 4 个 `test_voice_*.py` + `test_inline.py` | 见 §1.1 F9–F13 |
| `pyproject.toml` 的 `websockets` 依赖 | `pyproject.toml:18-19`，唯一使用者 `voice_observer.py:151` |

### R5 🟡 §13/D-1 的「全仓 grep 旧符号为零」不可达

旧符号大量存在于**历史文档与工作记忆**，且这些应当保留：

```text
Ayla/docs/plans/阶段四-M4-4爱莉桥接开发步骤.md     （elysia_client / run_bridge / ElysiaCredentialManager）
Ayla/docs/plans/阶段四-M4-5语音开发步骤.md
Ayla/docs/plans/阶段四-Elysia多媒体独立应用开发文档.md
Ayla/docs/report/Ayla后端独立启动修复记录.md
Ayla/docs/report/任务08-轮询改事件驱动交付记录-2026-09-01.md
Ayla/docs/服务器半容器化部署方案.md
Ayla/backend/README.md
.workbuddy/memory/2026-08-10.md、2026-08-11.md
.codex/memory/2026-08-10.md
```

→ **验收口径必须改为「`apps/` + `config/` + `tests/` 的 `*.py` 零命中」**，否则只能删历史文档（违反「只追加不覆盖」）。

### R6 🟡 跨仓库同名异义，禁止全局替换

- `ELYSIA_BASE_URL`：`Elysia-Harness/plugins/conscious-mind/src/tui.ts:48,60` 是 **LLM provider base URL**。
- `platform`：`Ayla/backend/apps/releases/*`（51 命中）是**客户端发布平台**。

### R7 🟡 生产死配置与日志噪音（收益项）

- 生产 `backend/.env` 仍有 5 个 `ELYSIA_*` 键 + `VOICE_OBSERVER_ENABLED=true`；`docker-compose.yml` 与 `nginx/nginx.conf` **无**桥接字面量，删键只需改 `backend/.env` 并 `docker compose up -d --no-deps backend`（`Ayla/deploy/README.md:149-150` 明确 restart 不重读 env_file）。
- 生产 `/app/runtime` **无 `elysia_credential.json`**，桥接线程每 60s 打 `RuntimeError: no enabled elysia profile` + traceback。删除 `inline.py` 后该噪音消失。
- ⚠️ 服务器上有他人工作（`breeze-tts2`、`napcat`、`portainer` 等容器），**本轮未做任何写操作**。

### R8 🔴 功能空窗（需 lead 决策）

删掉 `chat/views.py:618-620` 的 inject 钩子后，**Ayla → DSH 入站链路完全断开**，直到 D-3（WS consumer + outbox）落地。生产目前 0 profile、0 凭据，**实际无流量**，所以空窗风险低；但若 D-1 与 D-3 之间有人手工建 profile，会出现「消息发出、爱莉不回、无任何错误提示」。

### R9 🟡 `models.py` 引用的架构文档不存在

`models.py:19,34` 引用 `docs/architecture/Elysium接入Ayla平台模块.md`；实测 `Ayla/docs/architecture/` 无此文件，`git ls-files docs/architecture | grep -i elysium` 零命中。删字段时该 docstring 整段应一并删除，不要保留失效引用。

### R10 🔴 迁移回退可能失败（推断，未实测）

`0004` 的 `RemoveField(stream_id)` 反向操作是 `AddField(stream_id, CharField(max_length=240, unique=True))` —— **无 default、非空、唯一**。Django 对非空列加默认值需交互输入；非交互（`--no-input`）会失败。

- 生产 0 行 → 回退大概率成功；
- 本地 1 行 → **回退大概率失败**（`Cannot add a UNIQUE column` 或要求 one-off default）。

因此 D-2 写的「迁移可前进可回退（`migrate elysia_bridge 0004` / `0003`）」**只在空表成立**。

> 标注：**推断（未实测）**。本轮禁止改代码/迁移，无法执行验证。建议 D-2 执行时先在空测试库验证往返，再在本地 1 行库验证前进。

### R11 🟢 `ELYSIA_SSE_*` 早已是死配置

`settings.py:272-275` 定义了两个键，但**全仓无任何读取**：`run_bridge_loop` 用的是函数默认参数 `reconnect_seconds=3.0`（`services.py:1087`）与常量 `SSE_EVENT_TYPES`（`services.py:71`）。所以 `.env` 里调这两个值从来没生效过。

---

## 6. 与需求文档 §13 的偏差汇总

| # | §13 原文 | 实际 | 建议 |
|---|---|---|---|
| D1 | 列 7 类待删对象 | 实际需删 **12 个整文件 + 1 个片段（`services.py`）+ 1 个文件重写（`test_inject.py`）** | §13 补全 6 个 `test_voice_*`/`test_inline`、`views.py` 语音段、`urls.py` 语音路由、`chat/consumers.py` 语音组 |
| D2 | `services.py` 中「约 1000 行」 | 应删区间 82–1216，**约 1135 行** | 数字改为「约 1100 行」 |
| D3 | `ElysiaProfile.stream_id/platform/chat_type`「无消费者」 | **有 3 处后端消费者 + 2 个测试文件** | 改为「可删，但需同步改 C3/C12/C14/C15」 |
| D4 | 「表内 0 行」 | 生产 0 行 ✅；本地开发库 **1 行** | 注明「以生产为准；本地库有 1 行残留」 |
| D5 | 未提 `VOICE_OBSERVER_ENABLED` | `settings.py:282` + 生产 `.env:65` | 加入删除清单 |
| D6 | 「全仓 grep 旧符号为零」 | 历史文档/记忆必然命中 | 改为「`apps/`+`config/`+`tests/` 的 `*.py` 零命中」 |
| D7 | 「保留 `models.generate_elysia_stream_id` 之外的领域模型代码」 | 该措辞歧义：若理解为「删除该函数」，会打断 `serializers.py:17` 模块级 import → **全站 500** | 明确写「`generate_elysia_stream_id` 一并删除，并同步删 `serializers.py` 的自动生成逻辑」 |
| D8 | 未提 `websockets` 依赖 | 唯一使用者 `voice_observer.py:151` | 可随删除一并移除依赖（`httpx` 必须保留） |

---

## 附录 A：勘察用命令（可复现）

```bash
# 1. 符号级（backend）
cd Ayla/backend
grep -rn -F "ElysiaClient" apps config tests launcher.py --include="*.py" | grep -v __pycache__
grep -rn -F "elysia_client" ... ; grep -rn -F "run_bridge_loop" ... ; grep -rn -F "run_bridge" ...
grep -rn -F "ElysiaCredentialManager" ... ; grep -rn -F "voice_observer" ...
grep -rn -F "start_inline_bridge" ... ; grep -rn -F "stop_inline_bridge" ...
grep -rn -F "ELYSIA_BASE_URL" ... ; grep -rn -F "ELYSIA_CREDENTIAL_FILE" ...
grep -rn -F "ELYSIA_SSE_" ... ; grep -rn -F "ELYSIA_BRIDGE_INLINE" ...

# 2. 字段级（注意 -w 避免 stream_id 子串污染）
grep -rn -w "stream_id" apps config tests --include="*.py" | grep -v __pycache__
grep -rn -w "chat_type" apps config tests --include="*.py" | grep -v __pycache__
grep -rn -w "platform"  apps config --include="*.py" | grep -v __pycache__

# 3. 跨仓库
grep -rn -i "elysia_bridge|ElysiaClient|run_bridge|ElysiaCredentialManager|voice_observer|inline_bridge|ELYSIA_CREDENTIAL_FILE|ELYSIA_SSE_|ELYSIA_BRIDGE_INLINE" \
  Elysia-Harness/plugins/<kook-bot|qq-napcat|feishu-app|conscious-mind|subconscious|request-archive> --exclude-dir=node_modules

# 4. 服务器（只读）
ssh ayerelysia "cd ~/Elysia/ayla-deploy && cat backend/.env && grep -n 'env_file' docker-compose.yml && grep -nEi 'elysia|bridge' nginx/nginx.conf"
ssh ayerelysia "docker exec ayla-backend ls -la /app/runtime"
ssh ayerelysia "docker logs --tail 400 ayla-backend 2>&1 | grep -i elysia"
ssh ayerelysia "docker exec ayla-mysql mysql -uroot -N -e \"SELECT COUNT(*) FROM ayla.elysia_profiles\""

# 5. 前端基线（HEAD vs 工作树）
cd Ayla && git grep -n -i "elysia" HEAD -- web/src | wc -l    # 368
git grep -n -i "elysia" HEAD -- flutter/lib | wc -l           # 312
git status --porcelain | wc -l                                 # 76（并行 agent）
```

## 附录 B：本轮未验证项（不猜测）

1. **新实现（WS consumer / outbox）的实际接口** —— 尚不存在，D-1 无法据此写出最终替换代码；C7 只给方向。
2. **迁移 0004 回退的真实行为** —— 禁止改代码，见 R10（推断）。
3. **`test_outbound.py` 的基线失败数** —— 未跑测试（只读勘察，且 Ayla 工作树正被他人改动，跑测试会污染）。
4. **生产 `.env` 的其余键值** —— 只读了 `ELYSIA_*`/`VOICE_OBSERVER_ENABLED` 与脱敏后的键名列表，未读取密钥明文。
5. **前端并行 agent 的最终形态** —— 工作树仍在变动（19:52 与 19:58 两次快照不一致风险），以提交后为准。
