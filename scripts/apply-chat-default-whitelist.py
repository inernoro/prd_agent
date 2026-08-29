#!/usr/bin/env python3
"""把对话默认池收敛成一份「常用白名单」，并把默认指针切到它。

为什么需要这个脚本
------------------
网关的对话默认池是一次批量导入的产物，262 个成员按字母序排，第一个健康的是
`gpt-3.5-turbo`（输出上限 4096）。于是任何请求超过 4096 输出 token 的功能都会撞墙——
知识库「划词改写」请求 6000，生产上实测报：

    max_tokens is too large: 6000. This model supports at most 4096 completion tokens.

而池里那些真正能用的新模型（gpt-5.6 三个档）优先级排在 660 以后，永远轮不到。
同一个池里还混着近乎全失败的成员（30 天真实流量里 mistral-large-2512 十次零成功、
gemma-4-31b-it:free 十次一次成功），它们只会消耗重试预算。

做法不是给 262 个成员排序，而是**只留常用的那几个**：把白名单写进「对话默认池（精选）」，
再把该 ModelType 的默认指针切到这个池。原来那个 262 成员的池保持不动，随时可以切回去。

白名单的依据
------------
不是凭印象选的，是查 30 天真实调用记录（GET /gw/logs）选的：gpt-5.6 三个档在真实流量里
17 次调用全部成功。排序把 terra 放最前，是因为它在 openai/ 前缀那条路径上同样 3/3。

关于输出上限（maxTokens）
-------------------------
**故意不填。** 上游 /v1/models 与网关的 upstream-models 都不报输出上限，池里现有记录也是
null。凭记忆填一个数字，那道「按模型上限裁剪 max_tokens」的保护会拿错误的值去裁剪，
比不填更糟——填小了正常请求被截断，填大了照样撞上游的墙。要填就得先实测出真值。
`gpt-4.1-mini` 是个例外：它的 16384 是池里已经存在的既有记录，原样保留。

用法
----
    export GW_TOKEN=...          # 网关控制台 token，不要写进命令行历史
    python3 scripts/apply-chat-default-whitelist.py --dry-run   # 只看会改什么
    python3 scripts/apply-chat-default-whitelist.py             # 真正应用
    python3 scripts/apply-chat-default-whitelist.py --no-switch-default  # 只填白名单，不切指针

脚本是幂等的：重复跑结果一样。切默认指针是唯一一处影响面较大的动作，所以它单独有开关，
且会在执行前把「现在的默认池是谁」打出来，方便回滚。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_BASE = "https://main-prd-agent-llmgw.miduo.org"
CURATED_POOL_ID = "e3e8aa2d1a7747bea9cf36a88f11fe9f"
OPENAI_PLATFORM_ID = "40f3d21558b3476bbff9807b0c9ee5bc"

# 白名单：(modelId, platformId, priority, 选它的依据)
# 数字越小越优先。留出 10 的间隔，方便以后往中间插而不必整体重排。
WHITELIST = [
    ("gpt-5.6-terra", OPENAI_PLATFORM_ID, 10, "30 天真实流量 3/3 成功（含 openai/ 前缀路径）"),
    ("gpt-5.6-sol", OPENAI_PLATFORM_ID, 20, "30 天真实流量 10/10 成功，样本最多"),
    ("gpt-5.6-luna", OPENAI_PLATFORM_ID, 30, "30 天真实流量 4/4 成功"),
]


def request(method: str, base: str, path: str, token: str, body: dict | None = None) -> dict:
    url = base.rstrip("/") + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode()[:400]
        raise SystemExit(f"[失败] {method} {path} -> HTTP {exc.code}\n{detail}") from exc
    return json.loads(raw) if raw.strip() else {}


def unwrap(payload: dict) -> list:
    items = payload.get("data", payload)
    if isinstance(items, dict):
        items = items.get("items") or items.get("pools") or []
    return items or []


def find_pools(base: str, token: str) -> tuple[dict | None, dict | None]:
    """返回 (精选池, 当前 chat 默认池)。"""
    pools = unwrap(request("GET", base, "/gw/pools", token))
    curated = next((p for p in pools if p.get("id") == CURATED_POOL_ID), None)
    current_default = next(
        (p for p in pools if p.get("modelType") == "chat" and p.get("isDefaultForType")), None
    )
    return curated, current_default


def describe(pool: dict | None) -> str:
    if not pool:
        return "(不存在)"
    members = pool.get("models") or []
    healthy = [m for m in members if m.get("healthStatusLabel") == "Healthy"]
    head = sorted(healthy, key=lambda m: m.get("priority") or 0)[:1]
    first = head[0].get("modelId") if head else "(无健康成员)"
    return f"{pool.get('name')} [{pool.get('id')}] 成员 {len(members)}，健康 {len(healthy)}，最优先健康成员：{first}"


def main() -> int:
    parser = argparse.ArgumentParser(description="把对话默认池收敛成常用白名单")
    parser.add_argument("--base", default=os.environ.get("GW_BASE", DEFAULT_BASE))
    parser.add_argument("--dry-run", action="store_true", help="只打印将要执行的改动，不实际调用")
    parser.add_argument("--no-switch-default", action="store_true", help="只填白名单，不切默认指针")
    args = parser.parse_args()

    token = os.environ.get("GW_TOKEN", "").strip()
    if not token:
        print("[缺] 请先 export GW_TOKEN=<网关控制台 token>，不要把 token 写进命令行参数。", file=sys.stderr)
        return 2

    curated, current_default = find_pools(args.base, token)
    if curated is None:
        print(f"[缺] 找不到精选池 {CURATED_POOL_ID}，请先在控制台创建，或修改脚本里的 CURATED_POOL_ID。", file=sys.stderr)
        return 2

    print("改动前")
    print("  精选池      ：", describe(curated))
    print("  当前默认池  ：", describe(current_default))
    print()

    print("将写入的白名单")
    for model_id, platform_id, priority, why in WHITELIST:
        print(f"  prio {priority:3d}  {model_id:18s}  依据：{why}")
    if not args.no_switch_default:
        print(f"  并把 chat 的默认指针切到「{curated.get('name')}」")
    print()

    if args.dry_run:
        print("[dry-run] 未执行任何写操作。去掉 --dry-run 才会真正应用。")
        return 0

    for model_id, platform_id, priority, _why in WHITELIST:
        request(
            "PUT",
            args.base,
            f"/gw/pools/{urllib.parse.quote(CURATED_POOL_ID, safe='')}/models",
            token,
            {"modelId": model_id, "platformId": platform_id, "priority": priority},
        )
        print(f"  [有] {model_id} -> prio {priority}")

    if not args.no_switch_default:
        if current_default is not None:
            print(f"\n  回滚提示：原默认池是 {current_default.get('name')} [{current_default.get('id')}]")
        request(
            "PUT",
            args.base,
            f"/gw/pools/{urllib.parse.quote(CURATED_POOL_ID, safe='')}/default",
            token,
            {"isDefault": True},
        )
        print(f"  [有] chat 默认指针 -> {curated.get('name')}")

    curated_after, default_after = find_pools(args.base, token)
    print("\n改动后")
    print("  精选池      ：", describe(curated_after))
    print("  当前默认池  ：", describe(default_after))
    print("\n复测建议：打开任一录音笔记，选中一段文字点改写，确认不再报 max_tokens 超限。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
