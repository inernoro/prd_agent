#!/usr/bin/env python3
"""MAP 验收 · 回读知识库批注（验收智能体 ← 用户在验收文档上的划词/全文批注）。

闭环的另一半：archive_report.py 把验收报告「写」进知识库；本脚本把用户在那篇报告上
划词/框选留下的「批注」读回来，喂给验收智能体做下一轮复测。最简实现 = 按需轮询
后端聚合接口 GET /api/document-store/stores/{storeId}/recent-comments（按时间倒序）。
监听式（webhook/SSE 主动推送）留作后续，先用这条拉取路径跑通。

用法：
  python3 read_comments.py --config <acceptance.config.json> \
    [--store "验收报告" | --store <storeId>] \
    [--entry <entryId>]      # 只看某篇报告的批注
    [--since 2026-06-05T00:00:00Z]  # 增量：只看此时间后的新批注
    [--limit 50]

鉴权与归档脚本一致：优先 MAP_DOC_STORE_KEY（document-store:write，写蕴含读，可调本读接口），
未设回退 AI 超级密钥 + X-AI-Impersonate。base URL 走 config 的 previewUrlOverride 或 previewUrlCmd（cdscli）。

输出：先打印人类可读的批注清单，最后打印一行 `COMMENTS_JSON: {...}` 供智能体解析。
"""
import argparse, json, os, subprocess, time, sys, urllib.parse, datetime, re


def parse_iso(s):
    """ISO-8601 → 统一为 UTC aware datetime；失败返回 None。容忍 'Z' 与带时区偏移。"""
    if not s:
        return None
    s = s.strip().replace("Z", "+00:00")
    try:
        d = datetime.datetime.fromisoformat(s)
    except Exception:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=datetime.timezone.utc)
    return d.astimezone(datetime.timezone.utc)


def curl(args, retries=5):
    last = ""
    for i in range(retries):
        r = subprocess.run(["curl", "-s", "--max-time", "120"] + args, capture_output=True, text=True)
        last = r.stdout
        try:
            return json.loads(r.stdout)
        except Exception:
            if i < retries - 1:
                time.sleep(3 * (i + 1)); continue
    print("RAW(重试后仍失败):", (last or "")[:200], file=sys.stderr)
    raise RuntimeError("curl 返回非 JSON（多为预览环境 524/重启）")


def preview_from_cmd(cmd):
    out = subprocess.run(cmd, shell=True, capture_output=True, text=True).stdout
    lines = [l.strip() for l in out.splitlines() if l.strip()]
    return lines[-1] if lines else ""


def build_auth(cfg):
    """返回鉴权 header 列表，与 archive_report.run_doc_store 完全一致。"""
    api = cfg["auth"]["api"]
    agent_key_env = api.get("agentKeyEnv", "MAP_DOC_STORE_KEY")
    agent_key = os.environ.get(agent_key_env, "").strip()
    if agent_key:
        print(f"  鉴权：AgentApiKey scope（{agent_key_env}，document-store:write⊇read）", file=sys.stderr)
        return ["-H", f"Authorization: Bearer {agent_key}"]
    key = os.environ[api["keyEnv"]]
    imp = os.environ[api["impersonateEnv"]]
    print("  鉴权：AI 超级密钥 + impersonate（建议改用 MAP_DOC_STORE_KEY scoped key）", file=sys.stderr)
    return ["-H", f"{api['keyHeader']}: {key}", "-H", f"{api['impersonateHeader']}: {imp}"]


def resolve_store_id(H, base, store_arg, default_name):
    """store_arg 可为 storeId 或库名；为空时用 config 的 storeName。"""
    want = (store_arg or default_name or "").strip()
    if not want:
        raise SystemExit("未指定 --store，且 config.report.storeName 为空")
    # 仅当看起来像 store id（32 位十六进制 Guid）才按 id 直查；否则直接按名字查。
    # 库名常含空格/中文（如「验收报告」「Acceptance Reports」），拼进 /stores/{want} 会是非法 URL，
    # curl() 拿不到 JSON 会在回退到名字查找前就抛错（Codex P2）。
    if re.fullmatch(r"[0-9a-fA-F]{32}", want):
        direct = curl(H + [f"{base}/stores/{want}"])
        if isinstance(direct, dict) and direct.get("success") and (direct.get("data") or {}).get("id"):
            return direct["data"]["id"], direct["data"].get("name", want)
    # 按名字在列表里找
    listed = curl(H + [f"{base}/stores?pageSize=100"])
    items = (listed.get("data") or {}).get("items") or []
    match = [s for s in items if s.get("name") == want]
    if not match:
        raise SystemExit(f"找不到知识库「{want}」（既不是有效 storeId，也没有同名库）")
    return match[0]["id"], match[0]["name"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--store", default="", help="知识库名或 storeId（缺省用 config.report.storeName）")
    ap.add_argument("--entry", default="", help="只看某篇报告条目的批注（entryId）")
    ap.add_argument("--since", default="", help="增量：只看此 ISO 时间后创建的批注")
    ap.add_argument("--limit", type=int, default=50)
    a = ap.parse_args()

    cfg = json.load(open(a.config))
    base_url = (cfg.get("previewUrlOverride") or "").strip() or preview_from_cmd(cfg["previewUrlCmd"])
    if not base_url:
        raise SystemExit("拿不到预览 base URL（previewUrlOverride 为空且 cdscli 无输出）")
    base = base_url.rstrip("/") + cfg["report"]["apiBasePath"]
    H = build_auth(cfg)

    store_id, store_name = resolve_store_id(H, base, a.store, cfg["report"].get("storeName"))
    limit = max(1, min(200, a.limit))
    since = a.since.strip()

    if a.entry.strip():
        # 「只看某篇报告」：直接用 per-entry 接口拿该条目全量评论，再客户端按 since/limit 截取。
        # 不能走 store 级 recent-comments 再客户端过滤——store 很忙时前 N 条可能全是别的报告，
        # 目标条目被挤出页就会“明明有评论却读不到”（Codex P2）。
        r = curl(H + [f"{base}/entries/{a.entry.strip()}/inline-comments"])
        if not (isinstance(r, dict) and r.get("success")):
            raise SystemExit(f"读取条目批注失败：{json.dumps(r, ensure_ascii=False)[:200]}")
        items = r["data"].get("items", [])
        if since:
            # 解析为 datetime 再比较：since 可能带非 UTC 偏移（如 +08:00），与 API 的 UTC createdAt
            # 直接做字符串字典序比较会误判（Codex P2）。解析失败才退回字符串比较，避免静默全丢。
            since_dt = parse_iso(since)
            if since_dt is not None:
                items = [c for c in items
                         if (parse_iso(c.get("createdAt")) or datetime.datetime.min.replace(tzinfo=datetime.timezone.utc)) > since_dt]
            else:
                items = [c for c in items if (c.get("createdAt") or "") > since]
        items.sort(key=lambda c: c.get("createdAt") or "", reverse=True)
        items = items[:limit]
    else:
        qs = [f"limit={limit}"]
        if since:
            # since 含 ':' '+' 等字符，必须 URL 编码，否则网关/后端可能解析错（Bugbot Low）
            qs.append("since=" + urllib.parse.quote(since, safe=""))
        url = f"{base}/stores/{store_id}/recent-comments?" + "&".join(qs)
        res = curl(H + [url])
        if not (isinstance(res, dict) and res.get("success")):
            raise SystemExit(f"读取批注失败：{json.dumps(res, ensure_ascii=False)[:200]}")
        items = res["data"].get("items", [])

    # 人类可读清单
    print(f"知识库「{store_name}」最近批注（{len(items)} 条）")
    if not items:
        print("  （暂无新批注）")
    for c in items:
        who = c.get("authorDisplayName") or "未知用户"
        when = (c.get("createdAt") or "")[:19].replace("T", " ")
        where = c.get("entryTitle") or c.get("entryId") or "?"
        quote = (c.get("selectedText") or "").strip()
        tag = "全文" if c.get("isWholeDocument") else (f"原文「{quote[:40]}」" if quote else "锚点")
        flag = " [失锚]" if c.get("status") == "orphaned" else ""
        print(f"  · [{where}] {who} · {when}{flag}\n      {tag} → {c.get('content','').strip()}")

    # 机器可解析（验收智能体据此决定下一轮复测哪些点）
    print("COMMENTS_JSON: " + json.dumps({
        "storeId": store_id,
        "storeName": store_name,
        "count": len(items),
        "items": items,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
