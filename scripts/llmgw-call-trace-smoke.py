#!/usr/bin/env python3
"""调用全貌的冒烟：面板说会落到谁，就让运行时真解析一次，看落到谁。

这个脚本存在的唯一理由：面板的全部价值建立在「它说的和运行时做的是同一件事」上。
镜像对照测试证明两份判据在**同一组输入**上算出同一个答案；这里证明的是另一半——
面板读到的那组输入，就是运行时真的会用的那组。两件事都成立，面板才不是一份好看的假话。

两条真实路径各解析一次：
  1. 点名模型：expectedModel = <publicId>
  2. 只给 appCallerCode 不点名：expectedModel 留空，走该用途的默认

判据不是「HTTP 200」，是**运行时解析出的上游模型，等于面板推演的那一条**。
用 /gw/v1/resolve 而不是真发一次 chat：它走的是同一条 ModelResolver 判据，
但不打上游、不花钱、不留业务数据。花钱才能验的东西不该进冒烟。

按权重分配的模型不做单条断言（运行时落点由 requestId 派生），改断言「落在分到流量的那几条里」。

用法（密钥从环境变量取，不要写进命令行历史）：
  LLMGW_BASE=https://<预览域名> \\
  LLMGW_CONSOLE_TOKEN=<控制台会话 token> \\
  LLMGW_SERVICE_KEY=<gwk_ 接入密钥，需 route:read> \\
  LLMGW_APP_CALLER=<appCallerCode> \\
  python3 scripts/llmgw-call-trace-smoke.py <logicalModelId> [<modelType>]
"""
import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("LLMGW_BASE", "").rstrip("/")
CONSOLE_TOKEN = os.environ.get("LLMGW_CONSOLE_TOKEN", "")
SERVICE_KEY = os.environ.get("LLMGW_SERVICE_KEY", "")
APP_CALLER = os.environ.get("LLMGW_APP_CALLER", "")
# Cloudflare 对没有 User-Agent 的请求回 1010，长得和鉴权失败一模一样。踩过一次，别再踩。
UA = "llmgw-call-trace-smoke/1.0"


def http(method, url, headers, body=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("User-Agent", UA)
    for key, value in headers.items():
        req.add_header(key, value)
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
            return err.code, {"raw": raw[:400]}


def fetch_trace(logical_id):
    status, payload = http(
        "GET", f"{BASE}/llmgw/gw/logical-models/{logical_id}/call-trace",
        {"Authorization": f"Bearer {CONSOLE_TOKEN}"})
    if status != 200 or not payload.get("success"):
        raise SystemExit(f"拉调用全貌失败 status={status} body={str(payload)[:300]}")
    return payload["data"]


def upstream_of(route):
    return route.get("upstreamModelId") or route.get("targetName") or route.get("targetId")


def predicted(trace):
    """面板推演出的可接受落点集合 + 一句人话说明为什么是这个集合。"""
    eligible = [r for r in trace["routes"] if not r.get("skipReason")]
    if not eligible:
        return set(), "面板说一条能接的线路都没有，这次解析应当失败"
    if trace["routingStrategy"] == "weighted" and len(eligible) > 1:
        return ({upstream_of(r) for r in eligible},
                f"按权重分配，落点由请求派生，只断言落在这 {len(eligible)} 条里")
    head = min(eligible, key=lambda r: r.get("queuePosition") or 999)
    return {upstream_of(head)}, f"按顺位，面板说队首是第 {head.get('queuePosition')} 位"


def resolve(model_type, expected_model):
    body = {"appCallerCode": APP_CALLER, "modelType": model_type}
    if expected_model:
        body["expectedModel"] = expected_model
    return http("POST", f"{BASE}/gw/v1/resolve", {"Authorization": f"Bearer {SERVICE_KEY}"}, body)


def actual_upstream(payload):
    """运行时解析出的上游模型标识。字段名随版本有过变化，按优先级找，找不到就说找不到。"""
    for path in (("actualModel",), ("resolution", "actualModel"), ("data", "actualModel"),
                 ("modelId",), ("resolution", "modelId")):
        node = payload
        for key in path:
            node = node.get(key) if isinstance(node, dict) else None
            if node is None:
                break
        if isinstance(node, str) and node:
            return node
    return None


def main():
    if not (BASE and CONSOLE_TOKEN and SERVICE_KEY and APP_CALLER):
        print("缺少 LLMGW_BASE / LLMGW_CONSOLE_TOKEN / LLMGW_SERVICE_KEY / LLMGW_APP_CALLER", file=sys.stderr)
        return 2
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    logical_id = sys.argv[1]

    trace = fetch_trace(logical_id)
    model_type = sys.argv[2] if len(sys.argv) > 2 else trace["modelType"]
    accepted, why = predicted(trace)

    print(f"对外模型 : {trace['publicId']}（{trace['modelType']}，{trace['routingStrategy']}）")
    print(f"面板结论 : {trace['conclusion']}")
    print(f"推演落点 : {sorted(accepted) or '(无)'}  —— {why}")
    print(f"不点名   : {trace['unnamed']['summary']}")
    skipped = [r for r in trace["routes"] if r.get("skipReason")]
    if skipped:
        reasons = {}
        for route in skipped:
            reasons[route["skipReason"]] = reasons.get(route["skipReason"], 0) + 1
        print(f"不参与   : {', '.join(f'{k} {v} 条' for k, v in reasons.items())}")
    print()

    failures = []
    cases = [("点名模型", trace["publicId"])]
    # 不点名那条路只有在面板声称「会落到它」时才验落点归属；否则验的是别的模型，不是这一屏的事。
    if trace["unnamed"]["servesUnnamed"]:
        cases.append(("只给 appCallerCode 不点名", None))

    for label, expected_model in cases:
        status, payload = resolve(model_type, expected_model)
        got = actual_upstream(payload)
        if not accepted:
            ok = status >= 400 or got is None
            verdict = "按面板说法这次解析应当失败" if ok else f"面板说调不通，运行时却解析到 {got}"
        elif status != 200:
            ok, verdict = False, f"解析失败：{str(payload)[:220]}"
        elif got is None:
            ok, verdict = False, f"响应里找不到落点字段，无法核对：{str(payload)[:220]}"
        else:
            ok = got in accepted
            verdict = "与面板推演一致" if ok else f"面板说会落到 {sorted(accepted)}，运行时解析到 {got}"
        print(f"[{'通过' if ok else '失败'}] {label} — status={status} 运行时落点={got} · {verdict}")
        if not ok:
            failures.append(f"{label}：{verdict}")

    if not trace["unnamed"]["servesUnnamed"]:
        print("[跳过] 只给 appCallerCode 不点名 —— 面板声称不点名不会落到这个模型，"
              "落点归属属于另一个模型的全貌，不在这一屏的断言范围内")

    if failures:
        print("\n推演与运行时不一致，说明判据漂了：", file=sys.stderr)
        for item in failures:
            print(f"  - {item}", file=sys.stderr)
        return 1
    print("\n推演与运行时全部一致。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
