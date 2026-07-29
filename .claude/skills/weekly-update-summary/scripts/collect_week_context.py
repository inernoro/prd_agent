#!/usr/bin/env python3
"""
周报关联产物采集器（weekly-update-summary 纪律 9/10/11 的数据底座）。

git 只能回答「改了什么代码」，回答不了老板/产品经理真正要问的四件事：
  1. 这一周每天到底发生了什么（-> 日报知识库）
  2. 做完的东西验没验、验没验过（-> CDS 验收中心的 verdict）
  3. 质量在变好还是变差（-> 缺陷台账）
  4. 有没有真的发到线上（-> CDS 不可变部署版本）

本脚本把这四类「非 git 事实」按周聚合成一份 JSON，供周报正文引用。
所有来源都独立降级：任一来源不可达只把该段标 available=false，绝不让整份周报生不出来。

用法：
  python3 collect_week_context.py --week-start 2026-07-20 --week-end 2026-07-26 \
      [--base https://main-prd-agent.miduo.org] [--impersonate inernoro] \
      [--project prd-agent] [--out /tmp/week-context.json] [--human]

鉴权：
  MAP 侧同 publish.py —— DAILY_DOC_STORE_KEY / MAP_DOC_STORE_KEY 优先，回退 AI_ACCESS_KEY + impersonate。
  CDS 侧一律走 cdscli（禁止手拼 URL / 自己 slugify，见 CLAUDE.md 规则 11）。
"""
import argparse, json, os, re, subprocess, sys, time

API = "/api/document-store"
DAILY_STORE = "日报知识库"
WEEKLY_STORE = "周报知识库"
CDSCLI = ".claude/skills/cds/cli/cdscli.py"
VERDICTS = ("pass", "conditional", "fail")


def _curl(args, retries=3):
    last = ""
    for i in range(retries):
        r = subprocess.run(["curl", "-s", "--max-time", "90"] + args,
                           capture_output=True, text=True)
        last = r.stdout
        try:
            return json.loads(r.stdout)
        except Exception:
            if i < retries - 1:
                time.sleep(2 * (i + 1))
                continue
    raise RuntimeError("curl 返回非 JSON：" + (last or "")[:160])


def _headers(impersonate):
    key = (os.environ.get("DAILY_DOC_STORE_KEY", "").strip()
           or os.environ.get("MAP_DOC_STORE_KEY", "").strip())
    if key:
        return ["-H", f"Authorization: Bearer {key}"]
    sup = os.environ.get("AI_ACCESS_KEY", "").strip()
    if not sup:
        raise RuntimeError("缺少 DAILY_DOC_STORE_KEY / MAP_DOC_STORE_KEY / AI_ACCESS_KEY，无法访问 MAP")
    return ["-H", f"X-AI-Access-Key: {sup}", "-H", f"X-AI-Impersonate: {impersonate}"]


def _cdscli(args):
    """所有 CDS 读取都过 cdscli：它是凭据与 URL 的 SSOT，禁止本脚本自己拼 host。"""
    repo = os.environ.get("CDSCLI_REPO_ROOT", ".")
    cli = os.path.join(repo, CDSCLI)
    if not os.path.exists(cli):
        raise RuntimeError(f"找不到 cdscli：{cli}")
    env = dict(os.environ, CDSCLI_NO_DRIFT_CHECK="1")
    r = subprocess.run([sys.executable, cli] + args, capture_output=True, text=True,
                       timeout=180, env=env)
    # cdscli 正常输出单行 JSON；漂移提示等杂讯可能混在前面，取最后一个 JSON 行。
    for line in reversed((r.stdout or "").strip().splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except Exception:
                continue
    raise RuntimeError(f"cdscli {' '.join(args[:2])} 无 JSON 输出：{(r.stdout or r.stderr or '')[:160]}")


def _find_store(base, H, name):
    page = 1
    while True:
        res = _curl(H + [f"{base}{API}/stores?page={page}&pageSize=100"])
        if not res.get("success"):
            raise RuntimeError("列出知识库失败：" + json.dumps(res.get("error"), ensure_ascii=False)[:120])
        data = res.get("data") or {}
        items = data.get("items") or []
        for s in items:
            if s.get("name") == name:
                return s
        if data.get("hasNextPage") is False or len(items) < 100:
            return None
        page += 1
        if page > 200:
            raise RuntimeError("知识库分页异常，停止翻页")


def _in_week(date_text, start, end):
    """统一用日期文本比较（同 SKILL.md 纪律 1：不做时区换算）。"""
    return bool(date_text) and start <= date_text[:10] <= end


# ── 来源 1：日报知识库（本周逐日日报 + 可分享深链） ────────────────────────
def collect_daily_reports(base, H, start, end):
    store = _find_store(base, H, DAILY_STORE)
    if not store:
        return {"available": False, "reason": f"未找到「{DAILY_STORE}」"}
    sid = store["id"]

    entries, page = [], 1
    while True:
        res = _curl(H + [f"{base}{API}/stores/{sid}/entries?page={page}&pageSize=200&excludeFolders=true"])
        data = res.get("data") or {}
        items = data.get("items") or []
        entries += items
        if len(entries) >= (data.get("total") or 0) or not items:
            break
        page += 1
        if page > 50:
            break

    # entryId -> 分享 token，用于给非 CDS/非登录读者一个可点开的链接
    tok = {}
    try:
        sl = _curl(H + [f"{base}{API}/stores/{sid}/share-links"])
        for l in ((sl.get("data") or {}).get("items") or []):
            if l.get("entryId") and not l.get("isRevoked"):
                tok.setdefault(l["entryId"], l.get("token"))
    except Exception:
        pass

    out = []
    for e in entries:
        md = e.get("metadata") or {}
        d = (md.get("dailyDate") or "")[:10]
        if not d:
            m = re.search(r"(\d{4}-\d{2}-\d{2})", e.get("title") or "")
            d = m.group(1) if m else ""
        if not _in_week(d, start, end):
            continue
        t = tok.get(e["id"])
        out.append({
            "date": d,
            "title": e.get("title"),
            "entryId": e["id"],
            "shareUrl": f"{base}/s/lib/{t}?entry={e['id']}" if t else None,
            "summary": (e.get("summary") or "").strip()[:400] or None,
        })
    out.sort(key=lambda x: x["date"])
    missing = [d for d in _date_range(start, end) if d not in {o["date"] for o in out}]
    return {"available": True, "storeId": sid, "items": out,
            "count": len(out), "missingDates": missing}


def _date_range(start, end):
    import datetime as dt
    a = dt.date.fromisoformat(start)
    b = dt.date.fromisoformat(end)
    return [(a + dt.timedelta(days=i)).isoformat() for i in range((b - a).days + 1)]


# ── 来源 2：CDS 验收中心（本周验收报告 + verdict 结论 + 深链） ─────────────
# 验收类别对业务读者极重要：5 条 fail 全是「每日全量巡检」，和 5 个功能坏掉是两回事。
# 不分类会让老板把例行巡检的告警读成产品事故。
ACC_CATEGORIES = [
    ("每日巡检", re.compile(r"每日验收|全量变更|全量改动|每日巡检|昨日")),
    ("缺陷复测", re.compile(r"缺陷复测|缺陷管理|DEF-\d")),
    ("发布验收", re.compile(r"发布验收|正式发布|生产闭环")),
    ("PR 验收",  re.compile(r"PR\s*验收|#\d{3,}")),
]


def classify_acceptance(title):
    t = title or ""
    for name, rx in ACC_CATEGORIES:
        if rx.search(t):
            return name
    return "功能验收"


def collect_acceptance(project, start, end):
    res = _cdscli(["report", "list"] + (["--project", project] if project else []))
    if not res.get("ok"):
        return {"available": False, "reason": "cdscli report list 返回 ok=false"}
    rows = res.get("data") or []
    items = []
    for r in rows:
        if not _in_week(r.get("createdAt") or "", start, end):
            continue
        items.append({
            "id": r.get("id"),
            "title": r.get("title"),
            "date": (r.get("createdAt") or "")[:10],
            "verdict": (r.get("verdict") or "unknown").lower(),
            "category": classify_acceptance(r.get("title")),
            "tier": r.get("tier"),
            "prNumber": r.get("prNumber"),
            "branch": r.get("branch"),
            "commitSha": (r.get("commitSha") or "")[:7] or None,
            "projectSlug": r.get("projectSlug"),
            "deeplink": None,   # 逐条取深链慢，--deeplinks 时回填
        })
    items.sort(key=lambda x: (x["date"], x["title"] or ""))
    tally = {v: sum(1 for i in items if i["verdict"] == v) for v in VERDICTS}
    tally["unknown"] = sum(1 for i in items if i["verdict"] not in VERDICTS)
    total = len(items)

    # 按类别拆 verdict：业务读者要区分「例行巡检报警」与「功能验收没过」
    by_cat = {}
    for i in items:
        c = by_cat.setdefault(i["category"], {v: 0 for v in VERDICTS} | {"total": 0})
        c["total"] += 1
        if i["verdict"] in VERDICTS:
            c[i["verdict"]] += 1

    feat = [i for i in items if i["category"] == "功能验收"]
    feat_pass = sum(1 for i in feat if i["verdict"] == "pass")
    return {
        "available": True, "items": items, "count": total, "tally": tally,
        "passRate": round(tally["pass"] * 100.0 / total, 1) if total else None,
        "byCategory": by_cat,
        "featurePassRate": round(feat_pass * 100.0 / len(feat), 1) if feat else None,
        "featureCount": len(feat),
        "note": "verdict 口径：pass 通过 / conditional 有条件通过 / fail 未通过。"
                "整体通过率含每日巡检（例行全量扫描，天然易红）；featurePassRate 只算功能验收，"
                "更贴近『本周做的功能靠不靠谱』。",
    }


def acceptance_deeplink(report_id):
    try:
        r = _cdscli(["report", "deeplink", report_id])
        return ((r.get("data") or {}).get("url")) if r.get("ok") else None
    except Exception:
        return None


# ── 来源 3：缺陷台账（本周新报 + 存量健康度） ──────────────────────────────
def collect_defects(base, H, start, end):
    import datetime as dt
    to = (dt.date.fromisoformat(end) + dt.timedelta(days=1)).isoformat()
    wk = _curl(H + [f"{base}/api/defect-agent/stats/overview?from={start}T00:00:00Z&to={to}T00:00:00Z"])
    allt = _curl(H + [f"{base}/api/defect-agent/stats/overview"])
    if not wk.get("success") or not allt.get("success"):
        return {"available": False, "reason": "缺陷统计端点返回 success=false"}
    w, a = wk.get("data") or {}, allt.get("data") or {}
    return {
        "available": True,
        "week": {"newCount": w.get("total"), "statusCounts": w.get("statusCounts") or {},
                 "severityCounts": w.get("severityCounts") or {}},
        "backlog": {"total": a.get("total"), "open": a.get("openCount"),
                    "avgResolutionHours": a.get("avgResolutionHours")},
    }


# ── 来源 4：线上发布（不可变部署版本，回答「有没有真的发出去」） ──────────
def collect_releases(project, start, end):
    res = _cdscli(["deployment-version", "list"] + (["--project", project] if project else []))
    if not res.get("ok"):
        return {"available": False, "reason": "cdscli deployment-version list 返回 ok=false"}
    vers = ((res.get("data") or {}).get("versions")) or []
    items = [{"id": v.get("id"), "date": (v.get("createdAt") or "")[:10],
              "commitSha": (v.get("commitSha") or "")[:7], "branchId": v.get("branchId")}
             for v in vers if _in_week(v.get("createdAt") or "", start, end)]
    return {"available": True, "items": items, "count": len(items)}


# ── 来源 5：上周周报（保证「上周方向落地对照」有据可依） ────────────────────
def collect_prev_weekly(base, H, prev_title_hint):
    store = _find_store(base, H, WEEKLY_STORE)
    if not store:
        return {"available": False, "reason": f"未找到「{WEEKLY_STORE}」"}
    sid = store["id"]
    res = _curl(H + [f"{base}{API}/stores/{sid}/entries?page=1&pageSize=200&excludeFolders=true"])
    items = ((res.get("data") or {}).get("items")) or []
    hit = next((e for e in items if prev_title_hint and prev_title_hint in (e.get("title") or "")), None)
    return {"available": True, "storeId": sid,
            "prevEntry": {"title": hit.get("title"), "entryId": hit.get("id")} if hit else None}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--week-start", required=True)
    p.add_argument("--week-end", required=True)
    p.add_argument("--base", default="https://main-prd-agent.miduo.org")
    p.add_argument("--impersonate", default="inernoro")
    p.add_argument("--project", default="prd-agent")
    p.add_argument("--prev-week-hint", default="", help="上周周报标题片段，如 2026-W29")
    p.add_argument("--deeplinks", action="store_true", help="逐条取验收报告 CDS 深链（慢）")
    p.add_argument("--out", default="")
    p.add_argument("--human", action="store_true")
    a = p.parse_args()

    base, start, end = a.base.rstrip("/"), a.week_start, a.week_end
    ctx = {"weekStart": start, "weekEnd": end, "base": base, "project": a.project}

    try:
        H = _headers(a.impersonate)
    except Exception as e:
        H = None
        ctx["mapAuth"] = {"available": False, "reason": str(e)}

    for name, fn in [
        ("dailyReports", lambda: collect_daily_reports(base, H, start, end)),
        ("defects",      lambda: collect_defects(base, H, start, end)),
        ("prevWeekly",   lambda: collect_prev_weekly(base, H, a.prev_week_hint)),
    ]:
        if H is None:
            ctx[name] = {"available": False, "reason": "MAP 鉴权缺失"}
            continue
        try:
            ctx[name] = fn()
        except Exception as e:
            ctx[name] = {"available": False, "reason": str(e)[:200]}

    for name, fn in [
        ("acceptance", lambda: collect_acceptance(a.project, start, end)),
        ("releases",   lambda: collect_releases(a.project, start, end)),
    ]:
        try:
            ctx[name] = fn()
        except Exception as e:
            ctx[name] = {"available": False, "reason": str(e)[:200]}

    if a.deeplinks and ctx.get("acceptance", {}).get("available"):
        for it in ctx["acceptance"]["items"]:
            it["deeplink"] = acceptance_deeplink(it["id"])

    blob = json.dumps(ctx, ensure_ascii=False, indent=2)
    if a.out:
        with open(a.out, "w", encoding="utf-8") as f:
            f.write(blob)

    if a.human:
        print(f"===== 周报关联产物采集 {start} ~ {end} =====")
        d = ctx.get("dailyReports", {})
        if d.get("available"):
            print(f"[日报] {d['count']} 篇" + (f"，缺 {', '.join(d['missingDates'])}" if d.get("missingDates") else "，逐日齐全"))
            for i in d["items"]:
                print(f"   {i['date']}  {i['title']}  {i.get('shareUrl') or '(无分享链)'}")
        else:
            print("[日报] 不可用：" + str(d.get("reason")))
        ac = ctx.get("acceptance", {})
        if ac.get("available"):
            t = ac["tally"]
            print(f"[验收] {ac['count']} 份，通过 {t['pass']} / 有条件 {t['conditional']} / 未通过 {t['fail']}"
                  + (f"，整体通过率 {ac['passRate']}%" if ac.get("passRate") is not None else "")
                  + (f"；其中功能验收 {ac['featureCount']} 份，通过率 {ac['featurePassRate']}%"
                     if ac.get("featurePassRate") is not None else ""))
            for cat, c in sorted(ac.get("byCategory", {}).items()):
                print(f"   - {cat}: {c['total']} 份（通过 {c['pass']} / 有条件 {c['conditional']} / 未通过 {c['fail']}）")
            for i in ac["items"]:
                print(f"   {i['date']}  [{i['verdict']}] ({i['category']}) {i['title']}")
        else:
            print("[验收] 不可用：" + str(ac.get("reason")))
        df = ctx.get("defects", {})
        if df.get("available"):
            print(f"[缺陷] 本周新报 {df['week']['newCount']}；存量 {df['backlog']['total']}，未关 {df['backlog']['open']}，平均解决 {df['backlog']['avgResolutionHours']} 小时")
        else:
            print("[缺陷] 不可用：" + str(df.get("reason")))
        rl = ctx.get("releases", {})
        print(f"[发布] 本周不可变版本 {rl.get('count')}" if rl.get("available") else "[发布] 不可用：" + str(rl.get("reason")))
        if a.out:
            print(f"\n已写入 {a.out}")
    else:
        print(blob)


if __name__ == "__main__":
    main()
