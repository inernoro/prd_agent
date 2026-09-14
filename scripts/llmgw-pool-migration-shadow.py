#!/usr/bin/env python3
"""模型池搬迁的影子比对：同一批请求，新旧两条路解析出的物理模型必须一致。

为什么要这一步：搬迁把池翻成模型是一次批量写入，写完「看起来对」是不够的——
真正要回答的是「调用方发同样的请求，拿到的还是同一个上游吗」。不一致的逐条列出来，
不做统计掩盖（「99% 一致」这种说法对剩下那 1% 的调用方毫无意义）。

怎么比：
  旧路 = 把模型的默认标记全部关掉，解析走模型池；
  新路 = 按搬迁结果把默认标记打开，解析走逻辑模型。
  两次都打 /gw/v1/resolve，比 ActualModel + ActualPlatformId。

用法：
  python3 scripts/llmgw-pool-migration-shadow.py --base <网关地址> --token <控制台 token> --key <服务密钥>
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request


def call(url: str, token: str, method: str = "GET", body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        return {"success": False, "error": {"code": f"HTTP_{exc.code}", "message": exc.read().decode()[:400]}}


def resolve(base: str, key: str, app_caller: str, model_type: str) -> dict:
    """一次不点名模型的解析。回的是网关真正会用的那个上游。"""
    payload = {"appCallerCode": app_caller, "modelType": model_type}
    return call(f"{base}/gw/v1/resolve", key, "POST", payload)


def route_of(result: dict) -> tuple[str | None, str | None, str | None]:
    """从解析结果里取出「最终用的是哪个上游」。比这个，不比中间怎么走的。"""
    if not result.get("Success"):
        return (None, None, result.get("ErrorMessage") or result.get("FailureReason"))
    return (result.get("ActualModel"), result.get("ActualPlatformId"), result.get("ResolutionType"))


def set_default(base: str, token: str, logical_id: str, value: bool) -> bool:
    res = call(f"{base}/gw/logical-models/{logical_id}", token, "PUT", {"isDefaultForType": value})
    return bool(res.get("success"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--token", required=True, help="控制台 JWT")
    ap.add_argument("--key", required=True, help="带 route:read 的服务密钥")
    ap.add_argument("--app-caller", required=True)
    ap.add_argument("--model-types", default="", help="逗号分隔；留空表示用搬迁过的全部用途")
    args = ap.parse_args()

    models = call(f"{args.base}/gw/logical-models", args.token)
    if not models.get("success"):
        print("读取模型失败：", models.get("error"), file=sys.stderr)
        return 2
    items = models["data"]["items"]
    migrated = [x for x in items if (x.get("description") or "").startswith("由模型池")]
    if not migrated:
        print("没有搬迁过来的模型，无从比对。先跑一次 POST /gw/pools/migrate-to-models?apply=true", file=sys.stderr)
        return 2

    wanted = [x.strip() for x in args.model_types.split(",") if x.strip()]
    targets = [x for x in migrated if not wanted or x["modelType"] in wanted]

    print(f"比对 {len(targets)} 个用途，每个用途各解析两次（旧路走池、新路走模型）\n")
    mismatches: list[dict] = []
    for m in targets:
        model_type = m["modelType"]
        logical_id = m["id"]
        was_default = bool(m.get("isDefaultForType"))

        # 旧路：确保这个用途没有默认模型，解析必然回落到池
        if was_default and not set_default(args.base, args.token, logical_id, False):
            print(f"  [{model_type}] 无法临时关掉默认，跳过", file=sys.stderr)
            continue
        old = route_of(resolve(args.base, args.key, args.app_caller, model_type))

        # 新路：打开默认，解析走这个模型
        if not set_default(args.base, args.token, logical_id, True):
            print(f"  [{model_type}] 无法打开默认，跳过", file=sys.stderr)
            continue
        new = route_of(resolve(args.base, args.key, args.app_caller, model_type))

        # 恢复到比对之前的状态。比对是只读意图的动作，不该留下副作用。
        set_default(args.base, args.token, logical_id, was_default)

        same = old[0] == new[0] and old[1] == new[1]
        flag = "一致" if same else "不一致"
        print(f"  [{model_type:<12}] 旧路 {old[0] or old[2]} / 新路 {new[0] or new[2]}  → {flag}")
        if not same:
            mismatches.append({"modelType": model_type, "publicId": m["publicId"], "old": old, "new": new})

    print()
    if mismatches:
        print(f"有 {len(mismatches)} 个用途新旧两路解析不一致，逐条列出：")
        for x in mismatches:
            print(f"  {x['modelType']} · {x['publicId']}")
            print(f"      旧路 model={x['old'][0]} platform={x['old'][1]} ({x['old'][2]})")
            print(f"      新路 model={x['new'][0]} platform={x['new'][1]} ({x['new'][2]})")
        print("\n差异必须逐条解释清楚才能往下走。不解释就往前推，等于把问题留给调用方去撞。")
        return 1

    print(f"{len(targets)} 个用途新旧两路解析全部一致。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
