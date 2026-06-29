#!/usr/bin/env python3
"""生成网关测试矩阵的可见大报告 + 数据驱动 cell 目录（B/C 层 CI 真跑的 SSOT）。

纯 Python，无需 .NET SDK，现在就能跑。一处定义，三处消费：
- 写 `prd-api/tests/PrdAgent.Api.Tests/Gateway/fixtures/protocol-cells.json`（B 层 cell，xUnit [Theory] 读它真跑）。
- 写 `prd-api/tests/PrdAgent.Api.Tests/Gateway/fixtures/transport-cells.json`（C 层 cell，xUnit [Theory] 读它真跑）。
- 写 `doc/report.gw-test-matrix.md`（A 层 153 行解析全量 golden + B/C cell 全量 + 扩展维度），用户直接打开看。

关键：报告里 B/C 的每一行 = CI 真执行的一个 cell（不是只列不跑的"目录театр"）。
报告 A 层来自已提交 golden 夹具（CI golden 守卫的同一份）。D 层真机跑完追加。

每个 B cell 的 payload 都按真实适配器（OpenAIGatewayAdapter / ClaudeGatewayAdapter / ThinkTagStripper）
的解析行为构造，期望字段经源码核对（见脚本内注释引用的行为）。
"""
import collections
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GOLDEN = os.path.join(ROOT, "prd-api/tests/PrdAgent.Tests/fixtures/llm-resolution-golden.main.json")
FIX_DIR = os.path.join(ROOT, "prd-api/tests/PrdAgent.Api.Tests/Gateway/fixtures")
PROTOCOL_OUT = os.path.join(FIX_DIR, "protocol-cells.json")
TRANSPORT_OUT = os.path.join(FIX_DIR, "transport-cells.json")
REPORT_OUT = os.path.join(ROOT, "doc/report.gw-test-matrix.md")

MODEL_TYPES_13 = [
    "chat", "intent", "vision", "generation", "code", "long-context",
    "embedding", "rerank", "asr", "tts", "video-gen", "audio-gen", "moderation",
]

# 文本变体轴（E2 字符集 / E1 内容边界）。用 json.dumps 内嵌保证转义正确。
TEXT_VARIANTS = [
    ("ascii", "hello"),
    ("emoji", "thinking-emoji-✨"),
    ("cjk", "中文深度思考内容"),
    ("rtl", "مرحبا بالعالم"),
    ("spaces", "a   b   c"),
    ("quote", 'he said "hi" to me'),
    ("newline", "line1\nline2"),
    ("unicode", "Omega-Ω-approx-≈-sqrt-√"),
    ("long", "x" * 300),
]


def jd(obj):
    return json.dumps(obj, ensure_ascii=False)


def short(s, n=42):
    s = str(s).replace("\n", "\\n")
    return s if len(s) <= n else s[: n - 1] + "…"


def md_escape(s):
    return str(s).replace("|", "\\|").replace("\n", "\\n") if s is not None else ""


# ─────────────────────── B 层：协议保真 cell（executable，grounded） ───────────────────────
def build_protocol_cells():
    cells = []
    n = 0

    def add(**kw):
        nonlocal n
        n += 1
        kw["id"] = f"B{n:03d}"
        cells.append(kw)

    # OpenAI stream — reasoning_content → Thinking（adapter 行 125-131,164-165）
    for sfx, v in TEXT_VARIANTS:
        if not v.strip():
            continue
        add(group="openai-think-reasoning_content", dim="D5/E2", adapter="openai", method="stream",
            payload=jd({"choices": [{"delta": {"reasoning_content": v}}]}),
            expect={"chunkType": "Thinking", "content": v})
    # OpenAI stream — reasoning（OpenRouter 归一）→ Thinking
    for sfx, v in TEXT_VARIANTS:
        if not v.strip():
            continue
        add(group="openai-think-reasoning", dim="D5/E2", adapter="openai", method="stream",
            payload=jd({"choices": [{"delta": {"reasoning": v}}]}),
            expect={"chunkType": "Thinking", "content": v})
    # OpenAI stream — content → Text（adapter 行 121-123,167-168）
    for sfx, v in TEXT_VARIANTS:
        add(group="openai-content-text", dim="D2/E2", adapter="openai", method="stream",
            payload=jd({"choices": [{"delta": {"content": v}}]}),
            expect={"chunkType": "Text", "content": v})
    # OpenAI stream — finish_reason 全枚举 → Done（adapter 行 153-162；finish 优先级最高）
    for fr in ["stop", "length", "tool_calls", "content_filter"]:
        add(group="openai-finish", dim="E3", adapter="openai", method="stream",
            payload=jd({"choices": [{"delta": {}, "finish_reason": fr}]}),
            expect={"chunkType": "Done", "finishReason": fr})
    # OpenAI stream — finish + 尾随 content（finish 仍优先，content 挂在 Done 上）
    add(group="openai-finish-with-content", dim="E3", adapter="openai", method="stream",
        payload=jd({"choices": [{"delta": {"content": "tail"}, "finish_reason": "stop"}]}),
        expect={"chunkType": "Done", "finishReason": "stop", "content": "tail"})
    # OpenAI stream — usage-only（stream_options 末块 choices=[]）→ Done + token（行 170-172）
    for p, c in [(12, 7), (1, 0), (4096, 2048)]:
        add(group="openai-stream-usage", dim="D7", adapter="openai", method="stream",
            payload=jd({"choices": [], "usage": {"prompt_tokens": p, "completion_tokens": c}}),
            expect={"chunkType": "Done", "inputTokens": p, "outputTokens": c})
    # OpenAI stream — tool_calls delta → ToolCall（行 89-93）
    add(group="openai-tool-delta", dim="D6", adapter="openai", method="stream",
        payload=jd({"choices": [{"delta": {"tool_calls": [
            {"index": 0, "id": "call_1", "type": "function", "function": {"name": "f", "arguments": "{}"}}]}}]}),
        expect={"chunkType": "ToolCall"})
    add(group="openai-tool-delta-2", dim="D6/E8", adapter="openai", method="stream",
        payload=jd({"choices": [{"delta": {"tool_calls": [
            {"index": 0, "id": "c1", "type": "function", "function": {"name": "a", "arguments": "{}"}},
            {"index": 1, "id": "c2", "type": "function", "function": {"name": "b", "arguments": "{}"}}]}}]}),
        expect={"chunkType": "ToolCall"})
    # OpenAI stream — edge → null（行 84-85,174；空/空白/空对象/空 delta）
    for sfx, payload in [
        ("empty", ""), ("whitespace", "   "), ("empty-obj", "{}"),
        ("empty-delta", jd({"choices": [{"delta": {}}]})),
    ]:
        add(group="openai-edge-null", dim="E1", adapter="openai", method="stream",
            payload=payload, expect={"chunkType": "null"})
    # OpenAI nonstream tokenUsage（行 177-207）
    for p, c in [(30, 11), (0, 0), (1000, 500)]:
        add(group="openai-nonstream-usage", dim="D7", adapter="openai", method="tokenUsage",
            payload=jd({"usage": {"prompt_tokens": p, "completion_tokens": c}}),
            expect={"inputTokens": p, "outputTokens": c})
    # OpenAI nonstream toolCalls（行 238-239）
    add(group="openai-nonstream-tool", dim="D6", adapter="openai", method="toolCalls",
        payload=jd({"choices": [{"message": {"tool_calls": [
            {"id": "c1", "type": "function", "function": {"name": "g", "arguments": "{}"}}]}}]}),
        expect={"toolCount": 1})
    add(group="openai-nonstream-tool-2", dim="D6/E8", adapter="openai", method="toolCalls",
        payload=jd({"choices": [{"message": {"tool_calls": [
            {"id": "c1", "type": "function", "function": {"name": "g", "arguments": "{}"}},
            {"id": "c2", "type": "function", "function": {"name": "h", "arguments": "{}"}}]}}]}),
        expect={"toolCount": 2})
    # OpenAI messageContent（行 209-233）
    for sfx, v in TEXT_VARIANTS:
        add(group="openai-message-content", dim="D9/E2", adapter="openai", method="messageContent",
            payload=jd({"choices": [{"message": {"content": v}}]}),
            expect={"content": v})

    # Claude stream — content_block_delta → Text（行 272-278）
    for sfx, v in TEXT_VARIANTS:
        add(group="claude-content-text", dim="D2/E2", adapter="claude", method="stream",
            payload=jd({"type": "content_block_delta", "delta": {"text": v}}),
            expect={"chunkType": "Text", "content": v})
    # Claude stream — message_delta stop_reason 全枚举 → Done（行 280-306）
    for sr in ["end_turn", "max_tokens", "tool_use", "stop_sequence"]:
        add(group="claude-stop-reason", dim="E3", adapter="claude", method="stream",
            payload=jd({"type": "message_delta", "delta": {"stop_reason": sr}, "usage": {"output_tokens": 5}}),
            expect={"chunkType": "Done", "finishReason": sr})
    # Claude stream — message_stop → Done(stop)（行 308-313）
    add(group="claude-message-stop", dim="E3", adapter="claude", method="stream",
        payload=jd({"type": "message_stop"}), expect={"chunkType": "Done", "finishReason": "stop"})
    # Claude stream — error → Error chunk（行 315-321）
    add(group="claude-error", dim="D11", adapter="claude", method="stream",
        payload=jd({"type": "error", "error": {"message": "upstream boom"}}),
        expect={"chunkType": "Error", "error": "upstream boom"})
    # Claude stream — edge null
    for sfx, payload in [("empty", ""), ("unknown-type", jd({"type": "ping"}))]:
        add(group="claude-edge-null", dim="E1", adapter="claude", method="stream",
            payload=payload, expect={"chunkType": "null"})
    # Claude nonstream tokenUsage + cache（行 332-377）
    for i, o, cc, cr in [(40, 9, 15, 3), (100, 50, 0, 0), (10, 5, 7, 2)]:
        add(group="claude-usage-cache", dim="D7/E9", adapter="claude", method="tokenUsage",
            payload=jd({"usage": {"input_tokens": i, "output_tokens": o,
                                  "cache_creation_input_tokens": cc, "cache_read_input_tokens": cr}}),
            expect={"inputTokens": i, "outputTokens": o, "cacheCreation": cc, "cacheRead": cr})
    # Claude nonstream toolCalls：tool_use → 归一 OpenAI 形状（行 425-457）
    add(group="claude-tooluse-normalize", dim="D6", adapter="claude", method="toolCalls",
        payload=jd({"content": [{"type": "tool_use", "id": "tu_1", "name": "search", "input": {"q": "x"}}]}),
        expect={"toolCount": 1, "toolFirstName": "search", "toolFirstType": "function"})
    add(group="claude-tooluse-2", dim="D6/E8", adapter="claude", method="toolCalls",
        payload=jd({"content": [
            {"type": "tool_use", "id": "t1", "name": "alpha", "input": {}},
            {"type": "tool_use", "id": "t2", "name": "beta", "input": {}}]}),
        expect={"toolCount": 2, "toolFirstName": "alpha", "toolFirstType": "function"})
    # Claude messageContent content[0].text（行 379-417）
    for sfx, v in TEXT_VARIANTS:
        add(group="claude-message-content", dim="D9/E2", adapter="claude", method="messageContent",
            payload=jd({"content": [{"type": "text", "text": v}]}),
            expect={"content": v})

    # ThinkTagStripper（行为见 GatewayProtocolFidelityTests 既有通过用例）
    add(group="think-inline", dim="D5", method="thinkStripper", captureThinking=True,
        payloadChunks=["<think>推理内容</think>正式回答"],
        expect={"thinkVisible": "正式回答", "thinkCaptured": "推理内容"})
    add(group="think-cross-chunk", dim="D5/E4", method="thinkStripper", captureThinking=False,
        payloadChunks=["abc<thi", "nk>secret</thi", "nk>xyz"],
        expect={"thinkVisible": "abcxyz"})
    add(group="think-plain", dim="D5", method="thinkStripper", captureThinking=True,
        payloadChunks=["just text"],
        expect={"thinkVisible": "just text", "thinkCapturedEmpty": True})
    add(group="think-only", dim="D5", method="thinkStripper", captureThinking=True,
        payloadChunks=["<think>only thinking</think>"],
        expect={"thinkVisible": "", "thinkCaptured": "only thinking"})
    add(group="think-emoji-after", dim="D5/E2", method="thinkStripper", captureThinking=True,
        payloadChunks=["<think>t</think>done-✓-完成"],
        expect={"thinkVisible": "done-✓-完成", "thinkCaptured": "t"})

    return cells


# ─────────────────────── C 层：跨进程传输 cell（executable，grounded） ───────────────────────
def build_transport_cells():
    """每 cell 由 C# CrossProcessServingErrorLoadTests 的 [Theory] dispatch：
    gateway ∈ {echo, failing, throwing, empty}；method ∈ {send,stream,raw,pools,resolve,client-stream}；
    authOk；concurrency。expect 字段经端点 + HttpLlmGatewayClient 行为核对。"""
    cells = []
    n = 0

    def add(method, gateway, authOk, concurrency, expect, dim):
        nonlocal n
        n += 1
        cells.append({"id": f"C{n:03d}", "method": method, "gateway": gateway,
                      "authOk": authOk, "concurrency": concurrency, "expect": expect, "dim": dim})

    # send
    add("send", "echo", True, 1, {"success": True, "contentEcho": True}, "D1")
    add("send", "echo", False, 1, {"success": False, "statusCode": 401}, "E17")
    add("send", "failing", True, 1, {"success": False, "errorCodeNonEmpty": True}, "D11")
    add("send", "throwing", True, 1, {"success": False}, "D11")
    add("send", "empty", True, 1, {"success": True, "contentEmpty": True}, "E1")
    add("send", "echo", True, 16, {"success": True, "contentEcho": True, "concurrentNoCrossTalk": True}, "D12/E15")
    # stream
    add("stream", "echo", True, 1, {"minChunks": 2, "seqMonotonic": True, "textJoined": "hello"}, "D2")
    add("stream", "echo", False, 1, {"streamFailed": True}, "E17")
    add("stream", "failing", True, 1, {"streamHasError": True}, "D11")
    add("stream", "echo", True, 8, {"minChunks": 2, "concurrentNoCrossTalk": True}, "D12")
    # raw
    add("raw", "echo", True, 1, {"success": True}, "D8")
    add("raw", "failing", True, 1, {"success": False}, "D11")
    add("raw", "echo", False, 1, {"success": False, "statusCode": 401}, "E17")
    # pools
    add("pools", "echo", True, 1, {"poolsOk": True}, "D3")
    add("pools", "echo", False, 1, {"poolsFailed": True}, "E17")
    # resolve（ApiKey 不过线：echo 网关 resolve 设 ApiKey=SECRET，跨进程后必须 null）
    add("resolve", "echo", True, 1, {"actualModel": "m1", "apiKeyNull": True}, "E12/安全")
    add("resolve", "echo", False, 1, {"resolveFailed": True}, "E17")
    # client-stream（CreateClient → ILLMClient 代理到 /gw/v1/client-stream）
    add("client-stream", "echo", True, 1, {"minChunks": 2, "textJoined": "hi"}, "D2")
    return cells


# ─────────────────────── 扩展维度（emerge） ───────────────────────
EMERGE_DIMS = [
    ("E1 内容边界", "空响应 / 超长截断[TEXT_COS] / 单字符 / 纯空白", "B+C", "还原可读、截断标记、空内容兜底、不内联超长"),
    ("E2 字符集", "ASCII / emoji / CJK / RTL / 含引号 / 换行 / unicode 符号 / 300 字长串", "B", "原样透传不乱码"),
    ("E3 finish 全枚举", "openai stop/length/tool_calls/content_filter；claude end_turn/max_tokens/tool_use/stop_sequence/message_stop", "B", "归一为 Done + 保留原因"),
    ("E4 畸形 SSE", "跨 chunk 半截 <think> / 缺 [DONE] / 乱序 Seq / keepalive 心跳", "B+C", "缝合或兜底 Done、Seq 单调"),
    ("E5 断线续传", "afterSeq 重连从断点续 chunk", "C/D", "afterSeq 后不重发已收 chunk"),
    ("E6 vision 入图", "detail high/low/auto + 多图 + 坏图 URL", "B+D", "多图都解析、坏图兜底不崩"),
    ("E7 生图三格式", "base64 inline / [BASE64_IMAGE:sha] / COS URL", "B+D", "三格式归一成可显示 URL、不内联 base64"),
    ("E8 parallel tools", "多 tool_calls 并行（openai 数组 / claude 多 tool_use）", "B", "ToolCallCount 准、首个名称对"),
    ("E9 prompt-cache", "claude cache_creation vs cache_read 分别采集", "B+D", "cache token 分字段落库"),
    ("E10 池故障转移", "主池故障 → IsFallback=true + FallbackReason", "A+D", "兜底标记 + 原因可观测"),
    ("E11 exchange 中继", "exchange transformer 改写请求/响应", "A+B", "选对 transformer、协议来源记录"),
    ("E12 防选A给B", "直连 expectedModel + 跨进程 resolve ApiKey 不过线", "A+C+D", "actualModel==expected，ApiKey 跨进程恒 null"),
    ("E13 NotFound 黑洞", "无匹配池 → blackhole 落库（golden 中 7 条 NotFound）", "A+D", "Status=blackhole 入库可见（非静默丢）"),
    ("E14 假流式", "firstByte 慢 + 心跳文案分级(0-15/15-40/40s+)", "C+D", "心跳推进、文案带 model 名"),
    ("E15 租户隔离", "并发同 session 顺序 + 跨租户 UserId 不串（16 并发回显自己）", "C+D", "Context.UserId 各归各、非空"),
    ("E16 raw 大负载", "multipart 文件引用不内联 base64 + 图片 base64→sha", "C+D", "走对象存储引用、行不内联"),
    ("E17 鉴权三态", "无 key / 错 key / 对 key（C 层每方法都覆盖错 key→401）", "C", "401 / 401 / 200"),
    ("E18 协议来源三层", "pool-item > model > platform 各覆盖一次（golden ResolutionReason）", "A", "ResolutionReason 记录命中层级"),
    ("E19 ModelType 覆盖", "golden 实际出现 chat/intent/vision/generation/asr/embedding/rerank/tts/code/video-gen", "A", "每类至少一个入口注册并解析"),
    ("E20 观测落库闭环", "每 cell 跑完日志页可查 requestId + 字段", "D", "requestId 可查、字段齐"),
]


def render_report(rows, pcells, tcells):
    mt_counter = collections.Counter(
        (r["code"].split("::")[-1] if "::" in r["code"] else "(none)") for r in rows)
    rt_counter = collections.Counter(r["resolutionType"] for r in rows)
    pf_counter = collections.Counter(r["code"].split(".")[0] for r in rows)
    b_groups = collections.Counter(c["group"] for c in pcells)

    L = []
    A = L.append
    A("# report.gw-test-matrix —— 网关测试矩阵全量报告")
    A("")
    A("> 自动生成（`scripts/gen-gw-matrix-report.py`），勿手改。一处定义三处消费：本报告 +")
    A("> `protocol-cells.json`(B 层 [Theory]) + `transport-cells.json`(C 层 [Theory])。")
    A("> 报告里 B/C 的每一行都是 CI 真执行的一个 cell（非只列不跑）。矩阵设计 SSOT：")
    A("> `doc/spec.llm-gateway-test-matrix.md`；债务台账：`doc/debt.llm-gateway-isolation.md`。")
    A("")
    total = len(rows) + len(pcells) + len(tcells) + len(EMERGE_DIMS)
    A("全枚举、不压缩：")
    A(f"- **A 层解析全量**：{len(rows)} 个 appCallerCode 真实解析结果（golden SSOT，第 2 节）。")
    A(f"- **B 层协议保真**：{len(pcells)} 个数据驱动 cell，CI `GatewayProtocolFidelityTests` 真跑（第 3 节）。")
    A(f"- **C 层跨进程传输**：{len(tcells)} 个数据驱动 cell，CI `CrossProcessServingErrorLoadTests` 真跑（第 4 节）。")
    A(f"- **扩展维度**：{len(EMERGE_DIMS)} 个 emerge 维度（第 5 节）。")
    A(f"- **合计可见行数**：约 {total} 行。")
    A("")

    A("## 1. 概览（分布统计）")
    A("")
    A("### 1.1 按 ModelType（从 appCallerCode `::suffix` 解析）")
    A("")
    A("| ModelType | 入口数 |")
    A("|---|---|")
    for mt in MODEL_TYPES_13:
        if mt_counter.get(mt):
            A(f"| {mt} | {mt_counter[mt]} |")
    for mt, c in mt_counter.items():
        if mt not in MODEL_TYPES_13:
            A(f"| {mt}（非 13 类，需复核） | {c} |")
    A("")
    A("### 1.2 按解析档位")
    A("")
    A("| 档位 | 入口数 | 含义 |")
    A("|---|---|---|")
    desc = {"DedicatedPool": "命中专属模型池", "DefaultPool": "落 ModelType 默认池", "NotFound": "无匹配池（黑洞，预期内）"}
    for rt, c in rt_counter.most_common():
        A(f"| {rt} | {c} | {desc.get(rt, '')} |")
    A("")
    A(f"### 1.3 按应用前缀（{len(pf_counter)} 个应用）")
    A("")
    A("| 应用前缀 | 入口数 | | 应用前缀 | 入口数 |")
    A("|---|---|---|---|---|")
    items = sorted(pf_counter.items(), key=lambda x: (-x[1], x[0]))
    for i in range(0, len(items), 2):
        a = items[i]
        b = items[i + 1] if i + 1 < len(items) else ("", "")
        A(f"| {a[0]} | {a[1]} | | {b[0]} | {b[1]} |")
    A("")

    A(f"## 2. A 层：全部 {len(rows)} 个入口的真实解析结果（golden SSOT）")
    A("")
    A("> 每行 = 一个 appCallerCode 经 ModelResolver 解析后的真实落点。CI golden 守卫")
    A("> `LlmResolutionGoldenIntegrationTests` 比对同一份夹具；任一行漂移即报 mismatch。")
    A("")
    A("| # | appCallerCode | ModelType | 档位 | actualModel | 平台 | 协议 | 健康 | 兜底 | 解析依据 |")
    A("|---|---|---|---|---|---|---|---|---|---|")
    for i, r in enumerate(sorted(rows, key=lambda x: x["code"]), 1):
        A("| {} | {} | {} | {} | {} | {} | {} | {} | {} | {} |".format(
            i, md_escape(r["code"]), (r["code"].split("::")[-1] if "::" in r["code"] else "—"),
            md_escape(r["resolutionType"]), md_escape(r.get("actualModel") or "—"),
            md_escape(r.get("platformType") or "—"), md_escape(r.get("protocol") or "—"),
            md_escape(r.get("healthStatus") or "—"), "是" if r.get("isFallback") else "否",
            md_escape(r.get("resolutionReason") or "—")))
    A("")

    A(f"## 3. B 层：协议保真数据驱动 cell（{len(pcells)} 个，CI 真跑）")
    A("")
    A("> 喂 canned 上游 payload 给真实 `OpenAIGatewayAdapter`/`ClaudeGatewayAdapter`/`ThinkTagStripper`，")
    A("> 断言归一结果。`GatewayProtocolFidelityTests` 经 `[Theory]` 读 `protocol-cells.json` 逐 cell 执行。")
    A("")
    A("分组小计：" + " · ".join(f"{g}={c}" for g, c in sorted(b_groups.items())))
    A("")
    A("| # | adapter | method | 维度 | payload(节选) | 期望 |")
    A("|---|---|---|---|---|---|")
    for c in pcells:
        exp = ", ".join(f"{k}={short(v, 24)}" for k, v in c["expect"].items())
        pl = short(c.get("payload") or ("chunks:" + jd(c.get("payloadChunks", []))), 46)
        A(f"| {c['id']} | {c.get('adapter','—')} | {c['method']} | {c['dim']} | {md_escape(pl)} | {md_escape(exp)} |")
    A("")

    A(f"## 4. C 层：跨进程传输数据驱动 cell（{len(tcells)} 个，CI 真跑）")
    A("")
    A("> 真 Kestrel + 真 `HttpLlmGatewayClient` + stub gateway。`CrossProcessServingErrorLoadTests` 经")
    A("> `[Theory]` 读 `transport-cells.json` 逐 cell 执行（方法×上游×鉴权×并发）。")
    A("")
    A("| # | 方法 | 上游(stub) | 鉴权 | 并发 | 维度 | 期望 |")
    A("|---|---|---|---|---|---|---|")
    for c in tcells:
        exp = ", ".join(f"{k}={v}" for k, v in c["expect"].items())
        A(f"| {c['id']} | {c['method']} | {c['gateway']} | {'对' if c['authOk'] else '错'} | {c['concurrency']} | {c['dim']} | {md_escape(exp)} |")
    A("")

    A(f"## 5. 扩展维度（emerge，{len(EMERGE_DIMS)} 个）")
    A("")
    A("| 维度 | 取值 | 覆盖层 | 期望 |")
    A("|---|---|---|---|")
    for name, vals, layer, expect in EMERGE_DIMS:
        A(f"| {name} | {md_escape(vals)} | {layer} | {md_escape(expect)} |")
    A("")

    A("## 6. D 层：真机 live 结果（待 CDS 升级后追加）")
    A("")
    A("> CDS 支持单分支多容器 + 导入审批通过后，`scripts/gw-smoke.py` 对真网关跑全 153 resolve")
    A("> + 抽样真打 + 必败 canary，把 live 结果（model/finish/token/图片URL/requestId）追加到本节。当前为占位。")
    A("")
    return "\n".join(L) + "\n"


def main():
    rows = json.load(open(GOLDEN, encoding="utf-8"))
    pcells = build_protocol_cells()
    tcells = build_transport_cells()

    os.makedirs(FIX_DIR, exist_ok=True)
    json.dump(pcells, open(PROTOCOL_OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    json.dump(tcells, open(TRANSPORT_OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    open(REPORT_OUT, "w", encoding="utf-8").write(render_report(rows, pcells, tcells))

    print(f"written {PROTOCOL_OUT}  ({len(pcells)} cells)")
    print(f"written {TRANSPORT_OUT} ({len(tcells)} cells)")
    print(f"written {REPORT_OUT}")
    total = len(rows) + len(pcells) + len(tcells) + len(EMERGE_DIMS)
    print(f"  A {len(rows)} / B {len(pcells)} / C {len(tcells)} / emerge {len(EMERGE_DIMS)} = ~{total} visible rows")


if __name__ == "__main__":
    main()
