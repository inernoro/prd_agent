#!/usr/bin/env python3
"""调用全貌的冒烟：面板说会落到谁，就让运行时真解析一次，看落到谁。

这个脚本存在的唯一理由：面板的全部价值建立在「它说的和运行时做的是同一件事」上。
镜像对照测试证明两份判据在**同一组输入**上算出同一个答案；这里证明的是另一半——
面板读到的那组输入，就是运行时真的会用的那组。两件事都成立，面板才不是一份好看的假话。

两条真实路径：
  1. 点名模型：expectedModel = <publicId>，用 LLMGW_APP_CALLER 打一次
  2. 只给 appCallerCode 不点名：**逐个调用方**跑，不是挑一个样本

第 2 条为什么要逐个跑：2026-09-15 抓到的 P1 就栽在这里——面板那句「不点名会落到它」
此前没有主语，而这个脚本只跑了一个调用方，于是用一个样本判绿了一句全称命题。
运行时对配了专属池的调用方整个跳过对外模型这一档，那句话对他们从来就是假的。

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


def label_of(route):
    provider = route.get("providerName")
    name = route.get("upstreamModelId") or route.get("targetName") or route.get("targetId")
    return f"{provider} / {name}" if provider else name


def predicted(trace):
    """面板推演出的可接受落点 + 一句人话说明为什么是这些。

    比的是 **offeringId** 不是模型名：同一个上游模型可能被登记成两条线路（不同顺位、
    不同透传参数），按名字比会把「落到了另一条线路」判成一致。
    """
    eligible = [r for r in trace["routes"] if not r.get("skipReason")]
    if not eligible:
        return {}, "面板说一条能接的线路都没有，这次解析应当失败"

    # 权重轮转只在**最健康的那一档**里进行：运行时 GatewayRouteSelection.Queue 先按健康档
    # 排序，再只在队首那一档内部按权重转，降级线路留作故障转移候选、不参与首发。
    # 把所有没被跳过的线路都当成可接受落点的话，一个「错误地首发了降级线路」的回归照样能过
    # ——断言宽到把要防的那件事也放了进去（第 62 轮 review）。
    def health_tier(route):
        return 0 if (route.get("healthStatus") or 0) == 0 else 1

    best_tier = min(health_tier(r) for r in eligible)
    rotating = [r for r in eligible if health_tier(r) == best_tier]
    if trace["routingStrategy"] == "weighted" and len(rotating) > 1:
        standby = len(eligible) - len(rotating)
        note = f"，另有 {standby} 条降级线路只作故障转移、不参与首发" if standby else ""
        return ({r["id"]: label_of(r) for r in rotating},
                f"按权重分配，落点由请求派生，只断言落在最健康那一档的这 {len(rotating)} 条里{note}")
    head = min(eligible, key=lambda r: r.get("queuePosition") or 999)
    return {head["id"]: label_of(head)}, f"按顺位，面板说队首是第 {head.get('queuePosition')} 位"


def resolve(model_type, expected_model, app_caller=None):
    body = {"appCallerCode": app_caller or APP_CALLER, "modelType": model_type}
    if expected_model:
        body["expectedModel"] = expected_model
    return http("POST", f"{BASE}/gw/v1/resolve", {"Authorization": f"Bearer {SERVICE_KEY}"}, body)


def actual_route(payload):
    """运行时解析落到的那条线路：(offeringId, 人读标签)。

    /gw/v1/resolve 回的是 PascalCase（它直接序列化解析结果对象），和控制台那套
    camelCase 不是一回事——踩过一次，这里两种都认，免得下次改序列化策略又哑掉。
    """
    def pick(*names):
        for name in names:
            value = payload.get(name)
            if isinstance(value, str) and value:
                return value
        return None

    offering = pick("OfferingId", "offeringId")
    model = pick("ActualModel", "actualModel")
    platform = pick("ActualPlatformName", "actualPlatformName")
    label = f"{platform} / {model}" if platform and model else (model or offering)
    return offering, label


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
    print(f"推演落点 : {sorted(accepted.values()) or '(无)'}  —— {why}")
    print(f"不点名   : {trace['unnamed']['summary']}")
    print(f"调用方   : 登记 {trace['unnamed'].get('callerCount', 0)} 个，"
          f"其中 {trace['unnamed'].get('reachingCallerCount', 0)} 个不点名会落到它")
    skipped = [r for r in trace["routes"] if r.get("skipReason")]
    if skipped:
        reasons = {}
        for route in skipped:
            reasons[route["skipReason"]] = reasons.get(route["skipReason"], 0) + 1
        print(f"不参与   : {', '.join(f'{k} {v} 条' for k, v in reasons.items())}")
    print()

    failures = []

    # 点名那条路：用配置里给的调用方打一次。
    #
    # 先看这个调用方认不认对外模型目录——运行时那道门罩的不只是「不点名」那一档，它罩着
    # 整张目录：配了专属池的调用方哪怕点名这个模型，也走不到这里，请求落进它自己的池。
    # 所以对这种调用方要断言的是「运行时确实没走这张目录」，而不是「落点等于队首」。
    by_code = {c["appCallerCode"]: c for c in (trace["unnamed"].get("callers") or [])}
    named_reach = (by_code.get(APP_CALLER) or {}).get("reach", "UsesModelCatalog")
    status, payload = resolve(model_type, trace["publicId"])
    offering, got_label = actual_route(payload)
    succeeded = status == 200 and bool(payload.get("Success", payload.get("success", True)))
    if named_reach != "UsesModelCatalog":
        # 走不到这张目录的调用方：运行时不该给出这个模型的线路标识。
        ok = offering is None or offering not in accepted
        verdict = ("面板说它走不到这张目录，运行时确实没走（落到 %s）" % got_label if ok
                   else f"面板说它走不到这张目录，运行时却落到了这里的 {got_label}（{offering}）")
    elif not accepted:
        ok = not succeeded
        verdict = "按面板说法这次解析应当失败" if ok else f"面板说调不通，运行时却解析到 {got_label}"
    elif not succeeded:
        ok, verdict = False, f"解析失败：{str(payload)[:220]}"
    elif offering is None:
        ok, verdict = False, f"响应里找不到线路标识，无法核对：{str(payload)[:220]}"
    else:
        ok = offering in accepted
        verdict = ("与面板推演一致" if ok
                   else f"面板说会落到 {sorted(accepted.values())}，运行时解析到 {got_label}（{offering}）")
    reach_label = {"TrafficRejected": "未放行"}.get(named_reach, "认对外模型目录")
    print(f"[{'通过' if ok else '失败'}] 点名模型（{APP_CALLER}，{reach_label}） — "
          f"status={status} 运行时落点={got_label} · {verdict}")
    if not ok:
        failures.append(f"点名模型：{verdict}")

    # 不点名那条路：**逐个调用方**跑，不是挑一个样本。
    #
    # 2026-09-15 抓到的 P1 就栽在这里：面板那句「不点名会落到它」此前没有主语，
    # 而这个脚本只跑了一个调用方，于是用一个样本判绿了一句全称命题。
    # 现在面板逐个调用方给结论，这里就逐个调用方去对——面板说谁会落到它，就拿谁去解析一次。
    callers = trace["unnamed"].get("callers") or []
    if not callers:
        print("[跳过] 不点名 —— 这个用途下没有登记调用方，没有可对照的对象")
    for caller in callers:
        code = caller["appCallerCode"]
        reach = caller.get("reach")
        status, payload = resolve(model_type, None, app_caller=code)
        offering, got_label = actual_route(payload)
        succeeded = status == 200 and bool(payload.get("Success", payload.get("success", True)))

        if caller.get("reachesThisModel"):
            # 面板说这个调用方不点名会落到这个模型 —— 那就必须真的落到它的某条线路上。
            if not succeeded:
                ok, verdict = False, f"面板说会落到这个模型，运行时却解析失败：{str(payload)[:180]}"
            elif offering is None:
                ok, verdict = False, f"响应里找不到线路标识：{str(payload)[:180]}"
            else:
                ok = offering in accepted
                verdict = ("与面板推演一致" if ok
                           else f"面板说会落到 {sorted(accepted.values())}，运行时落到 {got_label}（{offering}）")
        elif reach == "TrafficRejected":
            ok = not succeeded
            verdict = "面板说这个调用方不放行，运行时确实解析不出来" if ok else f"面板说未放行，运行时却解析到 {got_label}"
        else:
            # 面板说走不到这个模型（被别的模型认领了，或本用途的默认不是它）。
            # 这里**不断言它落到哪**——那是另一个模型的全貌；只断言它没落到这个模型的线路上。
            landed_here = succeeded and offering is not None and offering in accepted
            ok = not landed_here
            verdict = ("确实没落到这个模型" if ok
                       else f"面板说走不到这里，运行时却落到了这个模型的 {got_label}（{offering}）")

        label = {"TrafficRejected": "未放行"}.get(reach, "认对外模型目录")
        print(f"[{'通过' if ok else '失败'}] 不点名 · {code}（{label}） — status={status} "
              f"运行时落点={got_label or '(无)'} · {verdict}")
        if not ok:
            failures.append(f"不点名 {code}：{verdict}")

    if failures:
        print("\n推演与运行时不一致，说明判据漂了：", file=sys.stderr)
        for item in failures:
            print(f"  - {item}", file=sys.stderr)
        return 1
    print("\n推演与运行时全部一致。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
