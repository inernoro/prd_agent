#!/usr/bin/env python3
"""Evidence ledger shared by daily/weekly/management-monthly reports. No writes to services."""
from __future__ import annotations

import argparse
from copy import deepcopy
from datetime import date, datetime, time, timedelta
import hashlib
import html
import json
import math
from pathlib import Path
import re
import subprocess
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

KINDS = {"commit", "merged", "started", "code_complete", "validation_passed",
         "validation_failed", "release_succeeded", "release_failed", "blocked", "unblocked"}
METRICS = {"efficiency": "效率", "hours": "工时", "benefit": "收益"}
LABELS = {"unknown": "未证实", "in_progress": "推进中", "complete": "完成",
          "passed": "通过", "failed": "失败", "stale": "变更后待复验", "released": "已上线"}


def stamp(value):
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise ValueError("事件时间必须含时区")
    return result


def bounds(start, end, timezone="Asia/Shanghai"):
    tz = ZoneInfo(timezone)
    lo = datetime.combine(date.fromisoformat(start), time.min, tz)
    hi = datetime.combine(date.fromisoformat(end) + timedelta(days=1), time.min, tz)
    if hi <= lo:
        raise ValueError("周期结束不能早于开始")
    return lo, hi


def source_check(source):
    if not isinstance(source, dict) or not all(source.get(k) for k in ("uri", "excerpt")):
        raise ValueError("每条证据必须有 source.uri 与 source.excerpt")
    uri = urlparse(source["uri"])
    if uri.scheme not in {"https", "http", "fixture"} or not uri.netloc:
        raise ValueError("来源仅接受 http(s) 或明确标注的 fixture URI")
    if uri.username or uri.password:
        raise ValueError("来源 URL 不得带凭据")


def normalize(ledger):
    if ledger.get("schemaVersion") != 1:
        raise ValueError("不支持的台账版本")
    result = deepcopy(ledger)
    items = result.get("workItems", [])
    ids = [i["id"] for i in items]
    if len(ids) != len(set(ids)) or any(not i.get("title") for i in items):
        raise ValueError("事项 ID 必须唯一且有标题")
    events = {}
    for e in result.get("events", []):
        if not re.fullmatch(r"[A-Za-z0-9_.:-]+", e.get("id", "")) or e.get("kind") not in KINDS:
            raise ValueError("事件 ID / kind 无效")
        if e.get("workItemId") is not None and e["workItemId"] not in ids:
            raise ValueError("事件引用了不存在的事项")
        stamp(e["occurredAt"])
        if e.get("timeBasis", "occurred") not in {"occurred", "observed"}:
            raise ValueError("timeBasis 必须区分事实发生与证据观测")
        source_check(e.get("source"))
        if e["kind"] in {"commit", "merged", "code_complete", "validation_passed",
                          "validation_failed", "release_succeeded", "release_failed"} and not e.get("revision"):
            raise ValueError("代码、验证、发布证据必须指定 revision")
        if e["kind"].startswith("validation_") and e.get("scope") not in {"feature", "ci"}:
            raise ValueError("验证必须区分 feature 与 ci")
        if e["kind"].startswith("release_") and e.get("environment") not in {"production", "preview"}:
            raise ValueError("发布必须区分 production 与 preview")
        if e["kind"] == "blocked" and not e.get("reason"):
            raise ValueError("阻塞必须有原因")
        if e["id"] in events and events[e["id"]] != e:
            raise ValueError("相同事件 ID 的内容冲突，拒绝静默覆盖")
        events[e["id"]] = e
    result["events"] = sorted(events.values(), key=lambda e: (stamp(e["occurredAt"]), e.get("order", 0), e["id"]))
    for m in result.get("measurements", []):
        if m.get("metric") not in METRICS or (isinstance(m.get("value"), bool) or not isinstance(m.get("value"), (float, int)) or not math.isfinite(m["value"])):
            raise ValueError("指标必须为已定义类型与数值")
        if not m.get("unit") or not m.get("method") or not m.get("population") or not m.get("sources"):
            raise ValueError("指标必须有单位、方法、样本范围和来源")
        bounds(m["start"], m["end"])
        for s in m["sources"]:
            source_check(s)
    return result


def state(events):
    s = {"code": "unknown", "validation": "unknown", "release": "unknown", "revision": None,
         "releasedRevision": None, "lastValidation": None, "blocked": False, "blockReason": None,
         "evidence": {"code": [], "validation": [], "release": [], "blocker": []}}
    first = {}
    for e in events:
        k, eid, rev = e["kind"], e["id"], e.get("revision")
        if k.startswith("validation_") and e["scope"] == "feature":
            s["lastValidation"] = {"status": "passed" if k == "validation_passed" else "failed", "revision": rev, "evidence": eid}
        if s["revision"] is None and (k.startswith("validation_") or k.startswith("release_")):
            s["revision"] = rev
        if k in {"commit", "merged", "code_complete"}:
            if rev != s["revision"]:
                s["revision"] = rev
                s["code"] = "in_progress"
                s["validation"] = "stale" if s["validation"] != "unknown" else "unknown"
                if s["validation"] == "stale":
                    s["evidence"]["validation"] = list(dict.fromkeys(s["evidence"]["validation"] + [eid]))
                # An old deployment remains historical evidence, not release of the new revision.
                s["release"] = "released" if s["releasedRevision"] == rev else "unknown"
            if s["code"] != "complete" or k == "code_complete":
                s["evidence"]["code"] = [eid]
            if k == "code_complete":
                s["code"] = "complete"
                first.setdefault("code", e)
        elif k == "started":
            if s["code"] == "unknown":
                s["code"] = "in_progress"
                s["evidence"]["code"] = [eid]
        elif k.startswith("validation_") and e["scope"] == "feature" and rev == s["revision"]:
            s["validation"] = "passed" if k == "validation_passed" else "failed"
            s["evidence"]["validation"] = [eid]
            if k == "validation_passed":
                first.setdefault("validation", e)
        elif k.startswith("release_") and e["environment"] == "production":
            if k == "release_succeeded":
                s["releasedRevision"] = rev
                first.setdefault("release", e)
            if rev == s["revision"]:
                s["release"] = "released" if k == "release_succeeded" else "failed"
                s["evidence"]["release"] = [eid]
        elif k in {"blocked", "unblocked"}:
            s["blocked"] = k == "blocked"
            s["blockReason"] = e.get("reason") if s["blocked"] else None
            s["evidence"]["blocker"] = [eid]
    return s, first


def analyze(ledger, start, end, cadence="weekly", timezone="Asia/Shanghai"):
    data = normalize(ledger)
    lo, hi = bounds(start, end, timezone)
    if cadence not in {"daily", "weekly", "monthly"}:
        raise ValueError("未知周期类型")
    # Facts after the reporting cut-off never affect a historical report.
    events = [e for e in data["events"] if stamp(e["occurredAt"]) < hi]
    by_id = {e["id"]: e for e in events}
    rows, claims = [], []
    counts = dict.fromkeys(("code", "validation", "release"), 0)
    for item in data["workItems"]:
        history = [e for e in events if e.get("workItemId") == item["id"]]
        if not history:
            continue
        current, first = state(history)
        previous, _ = state([e for e in history if stamp(e["occurredAt"]) < lo])
        period = [e for e in history if lo <= stamp(e["occurredAt"])]
        finished = current["code"] == "complete" and current["validation"] == "passed" and current["release"] == "released" and not current["blocked"]
        if not period and finished:
            continue
        milestones = [k for k, e in first.items() if lo <= stamp(e["occurredAt"]) < hi and e.get("timeBasis", "occurred") == "occurred"]
        for k in milestones:
            counts[k] += 1
        row = {"workItemId": item["id"], "title": item["title"], "owner": item.get("owner") or "待指定",
               "movement": "本期首次记录（不等于新增成果）" if stamp(history[0]["occurredAt"]) >= lo else ("延续推进" if period else "延续（本期无新证据）"),
               "previous": previous, "current": current, "newMilestones": milestones,
               "nextStep": item.get("nextStep"), "periodEvidence": [e["id"] for e in period],
               "historyEvidence": [e["id"] for e in history]}
        rows.append(row)
        for dim in ("code", "validation", "release"):
            claims.append({"workItemId": item["id"], "field": dim, "value": current[dim],
                           "sources": current["evidence"][dim], "basis": [e["id"] for e in history]})
        claims.append({"workItemId": item["id"], "field": "blocked", "value": current["blocked"],
                       "sources": current["evidence"]["blocker"], "basis": row["historyEvidence"]})
    # Risks first, then movement. Never force a fixed number of positive highlights.
    rows.sort(key=lambda r: (not (r["current"]["blocked"] or r["current"]["validation"] == "failed" or r["current"]["release"] == "failed"), r["workItemId"]))
    metrics = {}
    for key in METRICS:
        matches = [m for m in data.get("measurements", []) if m["metric"] == key and m["start"] == start and m["end"] == end]
        if len(matches) > 1:
            raise ValueError("同周期同指标存在多个口径，请先人工确认")
        metrics[key] = {"available": bool(matches), "reason": "缺少本周期可核查的测量，不能从提交数、代码量或跨日时长推算"}
        if matches:
            m = matches[0]
            metrics[key] = {"available": True, "measurement": m, "comparison": None}
            days = (date.fromisoformat(end) - date.fromisoformat(start)).days
            prev_end = date.fromisoformat(start) - timedelta(days=1)
            prev_start = prev_end - timedelta(days=days)
            prior = [p for p in data.get("measurements", []) if p["metric"] == key and p["end"] == prev_end.isoformat() and p["start"] == prev_start.isoformat() and all(p[x] == m[x] for x in ("method", "unit", "population"))]
            if len(prior) == 1:
                metrics[key]["comparison"] = {"previous": prior[0], "delta": m["value"] - prior[0]["value"]}
    unassigned = [e["id"] for e in events if e.get("workItemId") is None and lo <= stamp(e["occurredAt"]) < hi]
    return {"schemaVersion": 1, "cadence": cadence, "start": start, "end": end, "timezone": timezone,
            "inputDigest": hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False).encode()).hexdigest(),
            "newMilestones": counts if data.get("historyComplete") is True else dict.fromkeys(counts, None),
            "observedMilestones": counts, "historyComplete": data.get("historyComplete") is True, "items": rows, "claims": claims, "metrics": metrics,
            "unassignedEvidence": unassigned, "evidence": by_id,
            "limitations": data.get("limitations", []), "personalMonthly": "评价、认可和建议由员工本人表达；本产物只作管理事实参考，不代填、不提交。"}


def render_markdown(report):
    names = {"daily": "日报", "weekly": "周报", "monthly": "管理月度汇总（事实参考）"}
    c = report["newMilestones"]
    milestone_text = (f'本台账有证据的首次里程碑：功能完成 {c["code"]} 项 / 验证完成 {c["validation"]} 项 / 上线完成 {c["release"]} 项。各维度独立去重，不能相加为成果总数。'
                      if report["historyComplete"] else '历史覆盖不完整，不能确定本期新增成果数量；仅列已观察事实，不把首次采到的记录当作新增成果。')
    def short_revision(value):
        return value[:12] if value else "未证实"

    def source_link(eid):
        e = report["evidence"][eid]
        labels = {"commit":"开发记录", "merged":"合并记录", "started":"启动记录", "code_complete":"功能完成依据",
                  "validation_passed":"验证通过依据", "validation_failed":"验证失败依据",
                  "release_succeeded":"发布记录", "release_failed":"发布失败依据", "blocked":"阻塞依据", "unblocked":"解除阻塞依据"}
        return f'[{labels[e["kind"]]}](#e-{eid})'

    lines = [f'# {names[report["cadence"]]} · {report["start"]} ~ {report["end"]}', "",
             milestone_text,
             f'统计时区：{report["timezone"]}。未证实表示缺少证据，不表示没有发生。', "",
             "## 交付进展、风险与下一步", ""]
    if not report["items"]:
        lines.append("本期没有可归属事项；仍需检查未归属证据与采集缺口。")
    for r in report["items"]:
        s = r["current"]
        lines += [f'### {r["title"]} · {r["workItemId"]}',
                  f'- {r["movement"]}；负责人：{r["owner"]}。',
                  '- 状态：' + ' / '.join(f'{label} {LABELS[s[key]]}' for key, label in (("code", "功能"), ("validation", "验证"), ("release", "上线"))) + '。',
                  '- 上期状态：' + ' / '.join(f'{label} {LABELS[r["previous"][key]]}' for key, label in (("code", "功能"), ("validation", "验证"), ("release", "上线"))) + '。',
                  f'- 当前版本：{short_revision(s["revision"])}；历史已上线版本：{short_revision(s["releasedRevision"])}。',
                  f'- 风险：{s["blockReason"] if s["blocked"] else ("验证失败，需修复后复验" if s["validation"] == "failed" else ("上次验收失败，后续改动仍待复验" if s["validation"] == "stale" and s["lastValidation"] and s["lastValidation"]["status"] == "failed" else "旧验证不能覆盖后续修改，需补复验") if s["validation"] == "stale" else ("发布失败，需检查发布证据" if s["release"] == "failed" else "尚未取得完整交付证据" if s["release"] != "released" or s["validation"] != "passed" else "本台账无未解决风险证据"))}。']
        if s["lastValidation"]:
            v = s["lastValidation"]
            lines.append(f'- 最近功能验证：{LABELS[v["status"]]}；对应版本 {short_revision(v["revision"])}；{source_link(v["evidence"])}。')
        n = r.get("nextStep") or {}
        relevant = [refs[-1] for refs in s["evidence"].values() if refs]
        if s["lastValidation"]:
            relevant.append(s["lastValidation"]["evidence"])
        # Keep current supporting records in the management view; full history is in the source index.
        relevant = list(dict.fromkeys(relevant))[-5:]
        lines += [f'- 下一步：{n.get("action") or "待负责人确认"}；执行人：{n.get("owner") or "待指定"}；期限：{n.get("due") or "待确认"}。',
                  '- 核查来源：' + ' / '.join(source_link(eid) for eid in relevant) + '；完整历史见来源索引。', ""]
    lines += ["## 效率、工时与收益", ""]
    for k, label in METRICS.items():
        m = report["metrics"][k]
        if not m["available"]:
            lines.append(f'- {label}：不可用。{m["reason"]}。')
        else:
            x = m["measurement"]
            lines.append(f'- {label}：{x["value"]} {x["unit"]}；方法 {x["method"]}；样本 {x["population"]}。')
            for source in x["sources"]:
                lines.append(f'  来源：{source["uri"]} — {source["excerpt"]}')
            if m["comparison"]:
                p = m["comparison"]
                lines.append(f'  同口径上期差值：{p["delta"]} {x["unit"]}；不据此归因为某项代码变更。')
                for source in p["previous"]["sources"]:
                    lines.append(f'  上期来源：{source["uri"]} — {source["excerpt"]}')
            else:
                lines.append('  无同口径相邻周期测量，不判断效率升降。')
    lines += ["", "## 证据缺口", "", f'未归属证据 {len(report["unassignedEvidence"])} 条，不计成果；需明确事项关联。']
    lines += ['- ' + s for s in report["limitations"]]
    lines += ["", report["personalMonthly"], "", "## 来源索引", ""]
    for eid, e in report["evidence"].items():
        source = e["source"]
        lines += [f'<a id="e-{eid}"></a>', f'- {eid} · {e["occurredAt"]} · {e["kind"]} · {e.get("revision") or "无版本"} · {"证据观测时间，不计本期首次完成" if e.get("timeBasis") == "observed" else "事实发生时间"}',
                  f'  {source["uri"]}', f'  摘录：{source["excerpt"]}', ""]
    return '\n'.join(lines)


def render_html(report):
    # Escape all input, including evidence URIs. Only renderer-owned markup is emitted.
    md = render_markdown(report)
    body = []
    sources_open = False
    for line in md.splitlines():
        if line == "## 来源索引":
            body.append('<details><summary>核查来源与完整历史（' + str(len(report["evidence"])) + ' 条记录）</summary>')
            sources_open = True
            continue
        if line.startswith('<a id="e-'):
            body.append('<a id="' + html.escape(line.split('"')[1], quote=True) + '"></a>')
            continue
        escaped = html.escape(line)
        escaped = re.sub(r'\[([^\]]+)\]\(#(e-[^)]+)\)', r'<a href="#\2">\1</a>', escaped)
        if line.strip().startswith(("https://", "http://")):
            url = html.escape(line.strip(), quote=True)
            escaped = '<a rel="noreferrer" href="' + url + '">' + url + '</a>'
        if line.startswith('# '):
            body.append('<h1>' + escaped[2:] + '</h1>')
        elif line.startswith('## '):
            body.append('<h2>' + escaped[3:] + '</h2>')
        elif line.startswith('### '):
            body.append('<h3>' + escaped[4:] + '</h3>')
        elif line:
            body.append('<p>' + escaped + '</p>')
    if sources_open:
        body.append('</details>')
    emblem = {"daily": "moon", "weekly": "earth", "monthly": "sun"}[report["cadence"]]
    paths = {
        "moon": '<path d="M76 12a42 42 0 1 0 0 76A35 35 0 0 1 76 12Z"/>',
        "earth": '<circle cx="50" cy="50" r="41"/><ellipse cx="50" cy="50" rx="21" ry="41"/><path d="M10 50h80M16 28h68M16 72h68"/>',
        "sun": '<circle cx="50" cy="50" r="23"/><path d="M50 5v13M50 82v13M5 50h13M82 50h13M18 18l10 10M72 72l10 10M18 82l10-10M72 28l10-10"/>'}
    emblem_svg = '<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true" data-emblem="' + emblem + '">' + paths[emblem] + '</svg>'
    result = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>交付事实报告</title><style>
:root{--paper:#f7f1e8;--paper-2:#fffdf8;--ink:#211d18;--line:rgba(33,29,24,.14);--accent:#4f46e5}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.7 system-ui,sans-serif}main{max-width:1000px;margin:auto;padding:24px}header{position:relative;min-height:70px;border-bottom:3px solid var(--ink);display:flex;gap:16px;align-items:center}.emblem{position:absolute;right:0;top:0;width:70px;height:70px;opacity:.13;pointer-events:none}header b{padding:8px;background:var(--accent);color:white;box-shadow:3px 3px 0 var(--ink)}h1{font:700 30px/1.4 Georgia,serif}h2{border-top:2px solid var(--ink);padding-top:20px;font-size:23px}h3{margin-top:28px;border-left:4px solid var(--accent);padding-left:12px}summary{cursor:pointer;font-weight:600;padding:16px 0}details{border-top:2px solid var(--ink);margin-top:24px}p{overflow-wrap:anywhere;margin:8px 0}a{color:#4338ca}footer{overflow-wrap:anywhere;border-top:3px solid var(--ink);margin-top:24px;padding-top:12px;font:12px monospace}@media(max-width:600px){main{padding:16px}h1{font-size:24px}}
</style><main><header><b>MAP</b><span>交付事实 · 证据与连续进展</span><span data-emblem="''' + emblem + '''">''' + {"moon": "日报", "earth": "周报", "sun": "月度"}[emblem] + '</span><div class="emblem">' + emblem_svg + '</div></header>' + '\n'.join(body) + '<footer>输入摘要 ' + report["inputDigest"] + '</footer></main></html>'
    return result.replace('--accent:#4f46e5', '--accent:' + {"daily":"#c05b3c","weekly":"#4f46e5","monthly":"#a16207"}[report["cadence"]])


def git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args], check=True, text=True, capture_output=True).stdout.strip()


def collect_git(repo, base, head, ledger, mainline="origin/main"):
    """Collect (base, head] from a pinned mainline, expanding merge contents once.

    Explicit evidenceBindings associate commits/PRs with stable business IDs. No fuzzy title match.
    Merges prove integration only; they do not imply code complete, validation or production release.
    """
    data = normalize(ledger)
    if git(repo, "rev-parse", "--is-shallow-repository") != "false":
        raise ValueError("浅克隆不能建立完整事项历史，请先补全历史")
    base_sha, head_sha = git(repo, "rev-parse", base + "^{commit}"), git(repo, "rev-parse", head + "^{commit}")
    git(repo, "merge-base", "--is-ancestor", base_sha, head_sha)
    git(repo, "merge-base", "--is-ancestor", head_sha, git(repo, "rev-parse", mainline + "^{commit}"))
    remote = git(repo, "remote", "get-url", "origin")
    match = re.fullmatch(r'(?:https://github.com/|git@github.com:)([^/]+/[^/]+?)(?:\.git)?', remote)
    if not match:
        raise ValueError("当前采集器仅支持 GitHub origin，避免猜测提交来源 URL")
    canonical = "https://github.com/" + match[1]
    bindings = data.get("evidenceBindings", {})
    for existing in data["events"]:
        if existing["id"].startswith("git-"):
            resolved = bindings.get(existing["id"][4:]) or bindings.get("pr:" + str(existing["source"].get("prNumber")))
            if resolved:
                if existing.get("workItemId") not in (None, resolved):
                    raise ValueError("事项关联冲突，请先复核台账")
                existing["workItemId"] = resolved
    for tip in git(repo, "rev-list", "--first-parent", "--reverse", base_sha + ".." + head_sha).splitlines():
        parts = git(repo, "show", "-s", "--format=%P%n%cI%n%s", tip).splitlines()
        parents, when, title = parts[0].split(), parts[1], parts[2]
        pr = re.search(r'(?:Merge pull request #|\(#)(\d+)', title)
        work_id = bindings.get(tip) or (bindings.get("pr:" + pr[1]) if pr else None)
        children = git(repo, "rev-list", "--topo-order", "--reverse", tip + "^1.." + tip + "^2").splitlines() if len(parents) > 1 else []
        for order, sha in enumerate(children + [tip]):
            subject = git(repo, "show", "-s", "--format=%s", sha)
            original_time = git(repo, "show", "-s", "--format=%cI", sha)
            item_id = bindings.get(sha) or work_id
            data["events"].append({"id": "git-" + sha, "workItemId": item_id,
                "occurredAt": when if sha == tip else original_time, "order": order, "kind": "merged" if sha == tip else "commit", "revision": sha,
                "source": {"uri": canonical + "/commit/" + sha, "excerpt": subject,
                           "integratedBy": tip, "prNumber": pr[1] if pr else None, "originalCommittedAt": original_time, "integratedAt": when}})
    data.setdefault("limitations", []).append("Git 仅证实提交和主干合并；功能完成、验证、正式上线须补独立证据。未绑定事项的记录显式列入缺口。")
    # Expansions from multiple merges can refer to the same commit; keep its first integration.
    unique = {}
    for e in data["events"]:
        if e["id"] not in unique:
            unique[e["id"]] = e
        elif e["id"].startswith("git-"):
            if unique[e["id"]].get("workItemId") is None:
                unique[e["id"]]["workItemId"] = e.get("workItemId")
            elif e.get("workItemId") not in (None, unique[e["id"]]["workItemId"]):
                raise ValueError("事项关联冲突，请先复核台账")
        elif unique[e["id"]] != e:
            raise ValueError("事件 ID 冲突")
    data["events"] = list(unique.values())
    data["collection"] = {"base": base_sha, "head": head_sha, "repository": canonical}
    return normalize(data)


def write_reports(report, out):
    prefix = Path(out)
    prefix.parent.mkdir(parents=True, exist_ok=True)
    prefix.with_suffix('.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    prefix.with_suffix('.md').write_text(render_markdown(report))
    prefix.with_suffix('.html').write_text(render_html(report))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="command", required=True)
    collect = sub.add_parser("collect-git")
    collect.add_argument("--repo", default=".")
    collect.add_argument("--base", required=True)
    collect.add_argument("--head", required=True)
    collect.add_argument("--mainline", default="origin/main", help="head 必须可达的远端主干")
    collect.add_argument("--ledger", required=True)
    collect.add_argument("--out", required=True)
    render = sub.add_parser("render")
    render.add_argument("--ledger", required=True)
    render.add_argument("--start", required=True)
    render.add_argument("--end", required=True)
    render.add_argument("--cadence", choices=("daily", "weekly", "monthly"), required=True)
    render.add_argument("--timezone", default="Asia/Shanghai")
    render.add_argument("--out", required=True, help="输出前缀，生成 JSON/MD/HTML；不发布")
    a = p.parse_args()
    data = json.loads(Path(a.ledger).read_text())
    if a.command == "collect-git":
        Path(a.out).write_text(json.dumps(collect_git(a.repo, a.base, a.head, data, a.mainline), ensure_ascii=False, indent=2) + '\n')
    else:
        write_reports(analyze(data, a.start, a.end, a.cadence, a.timezone), a.out)


if __name__ == "__main__":
    main()
