#!/usr/bin/env python3
"""调用全貌的冒烟：面板说会落到谁，就真打一次看落到谁。

这个脚本存在的唯一理由：面板的全部价值建立在「它说的和运行时做的是同一件事」上。
守卫测试证明两份判据在**同一组输入**上算出同一个答案；这里证明的是另一半——
面板读到的那组输入，就是运行时真的会用的那组。两件事都成立，面板才不是一份好看的假话。

两条真实路径各打一次：
  1. 点名模型：请求体里给 model=<publicId>
  2. 只给 appCallerCode 不点名：请求体里不给 model

判据不是「HTTP 200」。是**实际落到的上游模型，等于面板推演的那一条**。
按权重分配的模型不做单条断言（运行时落点由请求派生），改断言「落在分到流量的那几条里」。

用法（不要把密钥写进命令行历史，从环境变量取）：
  LLMGW_BASE=https://<预览域名> \\
  LLMGW_CONSOLE_TOKEN=<控制台会话 token> \\
  LLMGW_SERVICE_KEY=<gwk_ 接入密钥> \\
  LLMGW_APP_CALLER=<appCallerCode> \\
  python3 scripts/llmgw-call-trace-smoke.py <logicalModelId>
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("LLMGW_BASE", "").rstrip("/")
CONSOLE_TOKEN = os.environ.get("LLMGW_CONSOLE_TOKEN", "")
SERVICE_KEY = os.environ.get("LLMGW_SERVICE_KEY", "")
APP_CALLER = os.environ.get("LLMGW_APP_CALLER", "")
# Cloudflare 对没有 User-Agent 的请求回 1010，长得和鉴权失败一模一样。踩过一次，别再踩。
UA = "llmgw-call-trace-smoke/1.0"


def http(method: str, url: str, headers: dict, body: dict | None = None, timeout: int = 120):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("User-Agent", UA)
    for k, v in headers.items():
        req.add_header(k, v)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as err:
        raw = err.read().decode(errors="replace")
        try:
            return err.code, json.loads(raw or "{}")
        except json.JSONDecodeError:
            return err.code, {"raw": raw[:500]}


def fetch_trace(logical_id: str) -> dict:
    status, payload = http(
        "GET", f"{BASE}/llmgw/gw/logical-models/{logical_id}/call-trace",
        {"Authorization": f"Bearer {CONSOLE_TOKEN}"})
    if status != 200 or not payload.get("success"):
        raise SystemExit(f"拉调用全貌失败 status={status} body={str(payload)[:300]}")
    return payload["data"]


def predicted(trace: dict) -> tuple[set[str], str]:
    """面板推演出的可接受落点集合，以及一句人话说明为什么是这个集合。"""
    routes = {r["id"]: r for r in trace["routes"]}
    eligible = [r for r in trace["routes"] if not r.get("skipReason")]
    if not eligible:
        return set(), "面板说一条能接的线路都没有，这次调用应当失败"

    def upstream_of(route) -> str:
        return route.get("upstreamModelId") or route.get("targetName") or route["targetId"]

    if trace["routingStrategy"] == "weighted" and len(eligible) > 1:
        return ({upstream_of(r) for r in eligible},
                f"按权重分配，落点由请求派生，只断言落在这 {len(eligible)} 条里")
    head = min(eligible, key=lambda r: r["queuePosition"] or 999)
    return {upstream_of(routes[head["id"]])}, f"按顺位，面板说队首是第 {head['queuePosition']} 位"


def call_gateway(model: str | None) -> tuple[int, dict]:
    body = {
        "messages": [{"role": "user", "content": "ping"}],
        "max_tokens": 8,
    }
    if model:
        body["model"] = model
    headers = {"Authorization": f"Bearer {SERVICE_KEY}"}
    if APP_CALLER:
        headers["X-App-Caller"] = APP_CALLER
    return http("POST", f"{BASE}/gw/v1/chat/completions", headers, body)


def actual_upstream(payload: dict) -> str | None:
    """这次实际用的上游模型。OpenAI 兼容响应把它放在 model 字段。"""
    value = payload.get("model")
    return str(value) if value else None


def main() -> int:
    if not (BASE and CONSOLE_TOKEN and SERVICE_KEY):
        print("缺少 LLMGW_BASE / LLMGW_CONSOLE_TOKEN / LLMGW_SERVICE_KEY", file=sys.stderr)
        return 2
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    logical_id = sys.argv[1]

    trace = fetch_trace(logical_id)
    accepted, why = predicted(trace)
    print(f"面板结论：{trace['conclusion']}")
    print(f"推演落点：{sorted(accepted) or '(无)'}  （{why}）")
    print(f"不点名那条路：{trace['unnamed']['summary']}")
    print()

    failures = []
    for label, model in (("点名模型", trace["publicId"]), ("只给 appCallerCode 不点名", None)):
        started = time.time()
        status, payload = call_gateway(model)
        elapsed = time.time() - started
        got = actual_upstream(payload)
        if not accepted:
            ok = status >= 400
            verdict = "按面板说法这次应当失败" if ok else "面板说调不通，实际却成功了"
        elif status != 200:
            ok, verdict = False, f"调用失败：{str(payload)[:200]}"
        elif got is None:
            ok, verdict = False, "响应里没有 model 字段，无法核对落点"
        else:
            ok = got in accepted
            verdict = "与面板推演一致" if ok else f"面板说会落到 {sorted(accepted)}，实际落到 {got}"
        print(f"[{'通过' if ok else '失败'}] {label} — status={status} 实际落点={got} 耗时={elapsed:.1f}s · {verdict}")
        if not ok:
            failures.append(f"{label}：{verdict}")

    # 「不点名会不会落到它」这一问单独核：面板说会，就必须真的会。
    print()
    if trace["unnamed"]["servesUnnamed"]:
        print("注意：面板声称不点名会落到这个模型。上面第二条就是它的实打验证。")
    else:
        print("注意：面板声称不点名不会落到这个模型，所以第二条只验「调得通」，不验落点归属。")

    if failures:
        print("\n推演与实打不一致，说明判据漂了：", file=sys.stderr)
        for item in failures:
            print(f"  - {item}", file=sys.stderr)
        return 1
    print("\n推演与实打全部一致。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
