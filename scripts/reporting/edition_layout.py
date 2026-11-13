"""Render evidence in the existing daily newspaper / weekly magazine skill templates.

The templates supply the actual press CSS and masthead. Historical sample prose is
never copied into an edition. This module does not collect, publish, or submit data.
"""
from __future__ import annotations

from datetime import date, timedelta
import hashlib
import html
import json
from pathlib import Path
import re
from urllib.parse import urlsplit

from evidence import LABELS, stamp

ROOT = Path(__file__).resolve().parents[2]
TEMPLATES = {
    "daily": ROOT / ".claude/skills/daily-report-summary/reference/report-template-html.html",
    "weekly": ROOT / ".claude/skills/weekly-update-summary/reference/report-template-html.html",
}
SOURCE_NAMES = {"dailyReports": "日报知识库", "acceptance": "验收中心", "defects": "缺陷台账",
                "releases": "正式发布台账", "teamInsights": "团队与成本", "adoption": "采用度"}
SUN = '''<div class="emblem"><svg viewBox="0 0 120 120" fill="none" data-emblem="sun" aria-hidden="true"><defs><pattern id="emb-sun-h" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(-35)"><path d="M0 0V7" stroke="currentColor" stroke-width="2" opacity=".45"/></pattern></defs><circle cx="60" cy="60" r="29" fill="currentColor" fill-opacity=".16"/><circle cx="60" cy="60" r="29" fill="url(#emb-sun-h)" stroke="currentColor" stroke-width="3"/><path d="M60 9v13M60 98v13M9 60h13M98 60h13M24 24l9 9M87 87l9 9M24 96l9-9M87 33l9-9" stroke="currentColor" stroke-width="4"/></svg></div>'''
CSS = '''
/* Machine-filled edition: compact source facts inside the original press layout. */
.edition-nav{display:flex;gap:8px 18px;flex-wrap:wrap;margin:18px 0;font-size:12px}
.edition-nav a{color:var(--ink-2);text-decoration:underline;text-underline-offset:3px}
.edition-summary{border:1.5px solid var(--ink);background:var(--paper-2);padding:18px 20px;box-shadow:5px 5px 0 rgba(33,29,24,.12);margin:26px 0}
.edition-summary h1{font:700 clamp(25px,4vw,35px)/1.45 var(--serif);margin:0 0 12px}
.edition-summary p,.edition-copy{font-size:14px;line-height:1.9;color:var(--ink-2);margin:8px 0}
.edition-failure{border-left-color:#b42318!important}.edition-phase .st-passed,.edition-phase .st-released,.edition-phase .st-complete{color:#1a7f37}
.edition-warning{border-left:3px solid #9a6700;background:rgba(154,103,0,.05);padding:12px 16px;margin:10px 0;font-size:13px;line-height:1.9}
.edition-item{border:1px solid var(--line-2);background:var(--paper-2);padding:18px 20px;margin:16px 0;box-shadow:3px 3px 0 rgba(33,29,24,.06)}
.edition-item h3{font:700 21px/1.5 var(--serif);margin:4px 0 10px}
.edition-meta{font:11px/1.8 var(--mono);color:var(--ink-3);overflow-wrap:anywhere;margin:8px 0}
.edition-phase-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:14px 0}
.edition-phase{border-top:2px solid var(--ink);padding:10px 12px;background:var(--paper);font-size:12px;line-height:1.8;min-width:0}
.edition-phase strong{display:block;font:600 17px/1.7 var(--serif)}
.edition-phase .st-failed{color:#b42318}.edition-phase .st-stale{color:#9a6700}
.edition-sources{margin:12px 0;border-top:1px dotted var(--line);padding-top:10px;font-size:12px;line-height:1.85}
.edition-sources summary{cursor:pointer;font-weight:600}.edition-sources ol{padding-left:22px;margin:8px 0}
.edition-sources li{margin:8px 0}.edition-sources p{margin:4px 0}
.edition-item p,.edition-warning p,.edition-trail p,.edition-sources p,.edition-sources a{overflow-wrap:anywhere}
.edition-item a,.edition-warning a,.edition-trail a,.edition-sources a{color:var(--indigo,#4f46e5);text-underline-offset:3px}
.edition-trail{list-style:none;padding:0;margin:12px 0}.edition-trail>li{border-bottom:1px dotted var(--line);padding:12px 0;font-size:13px;line-height:1.9}
.edition-source-status{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:12px 0}.edition-source-status>div{border:1px solid var(--line);padding:12px;background:var(--paper-2);font-size:12px;line-height:1.8;overflow-wrap:anywhere}
.edition-section{scroll-margin-top:18px}.edition-section h2{font:700 21px/1.6 var(--serif);padding-bottom:8px;border-bottom:2px solid var(--ink);margin:32px 0 12px}
.edition-footer{font:10px/1.9 var(--mono);color:var(--ink-3);border-top:3px solid var(--ink);margin-top:30px;padding-top:12px;overflow-wrap:anywhere}
@media(max-width:640px){.masthead{flex-wrap:wrap;gap:12px}.masthead .t{min-width:0;flex:1}.masthead .t b{font-size:21px}.masthead .t span{letter-spacing:.14em}.masthead .r{width:100%;text-align:left;margin-left:58px;letter-spacing:.06em}.edition-item,.edition-summary{padding:15px}.edition-phase-grid,.edition-source-status{grid-template-columns:1fr}.edition-item h3{font-size:19px}.edition-nav{gap:10px 14px}}
'''


def _text(value):
    return html.escape(str(value if value is not None else ""), quote=True)


def _md(value):
    s = str(value if value is not None else "").replace("\n", " ")
    s = html.escape(s, quote=False)
    return re.sub(r"([\\`*\[\]_|])", r"\\\1", s)


def _url(value):
    if not isinstance(value, str):
        return None
    try:
        p = urlsplit(value)
    except ValueError:
        return None
    return value if p.scheme in {"http", "https"} and p.netloc and not p.username and not p.password else None


def _anchor(eid):
    return "e-" + str(eid)


def _links(ids, evidence):
    ids = list(dict.fromkeys(eid for eid in ids if eid in evidence))
    links = []
    selected = list(enumerate(ids)) if len(ids) <= 3 else [(0, ids[0]), (len(ids)-2, ids[-2]), (len(ids)-1, ids[-1])]
    for n, eid in selected:
        source = evidence[eid].get("source") or {}
        url = _url(source.get("uri"))
        label = "依据 " + str(n + 1)
        links.append(f'<a href="{_text(url)}" target="_blank" rel="noopener noreferrer" data-evidence-id="{_text(eid)}" title="{_text(source.get("excerpt", ""))}">{label}</a>' if url else f'<span>{label}（来源不可公开访问，见完整历史）</span>')
    if len(ids) > 3:links.append(f'<span>另{len(ids)-3}条见文末完整历史</span>')
    return " · ".join(links) or "尚无直接阶段证据"


def _md_links(ids, evidence):
    ids = list(dict.fromkeys(eid for eid in ids if eid in evidence))
    return " / ".join(f"[依据 {n + 1}](#{_anchor(eid)})" for n, eid in enumerate(ids)) or "尚无直接阶段证据"


def _source_link(item):
    for key in ("sourceUrl", "shareUrl", "deeplink", "url", "uri"):
        value = _url(item.get(key))
        if value:
            return value
    source = item.get("source")
    return _url(source.get("uri")) if isinstance(source, dict) else None


def _next(item):
    value = item.get("nextStep") or {}
    if isinstance(value, str):
        value = {"action": value}
    return (value.get("action") or "待负责人明确下一步", value.get("owner") or item.get("owner") or "待指定", value.get("due") or "待确认")


def _ci_failure(item, evidence):
    current = item["current"]
    if "ciFailed" in current:
        ids = current.get("ciEvidence", [])
        return evidence.get(ids[-1]) if current["ciFailed"] and ids else None
    events = [e for e in evidence.values() if e.get("workItemId") == item["workItemId"]
              and e.get("scope") == "ci" and e.get("revision") == current.get("revision")
              and e.get("kind") in {"validation_failed", "validation_passed"}]
    events.sort(key=lambda e: (stamp(e["occurredAt"]), e.get("order", 0), e.get("id", "")))
    return events[-1] if events and events[-1]["kind"] == "validation_failed" else None


def _risks(item, evidence):
    current = item["current"]
    reasons = []
    if current.get("blocked"):
        reasons.append(current.get("blockReason") or "存在尚未解除的阻塞")
    if current.get("validation") == "failed":
        reasons.append("当前版本功能验证失败")
    elif current.get("validation") == "stale":
        reasons.append("变更后待复验，旧版本结论不能覆盖后续修改")
    if current.get("release") == "failed":
        reasons.append("当前版本正式发布失败")
    ci = _ci_failure(item, evidence)
    if ci:
        reasons.append("当前版本 CI 失败；CI 与功能验收分别跟踪")
    refs = list(current.get("evidence", {}).get("blocker", []))
    refs += current.get("evidence", {}).get("validation", []) + current.get("evidence", {}).get("release", [])
    if ci:
        refs.append(ci["id"])
    return reasons, refs


def _template(cadence):
    path = TEMPLATES["daily" if cadence == "daily" else "weekly"]
    text = path.read_text(encoding="utf-8")
    if 'data-edition-template="v1"' not in text:
        raise ValueError("技能原模板缺少版式接线标记，拒绝改用独立通用页面")
    css = re.search(r"<style[^>]*>(.*?)</style>", text, re.S | re.I)
    masthead = re.search(r'<header\s+class="masthead">.*?</header>', text, re.S)
    if not css or not masthead:
        raise ValueError("技能原模板缺少刊系样式或报头")
    style = re.sub(r"/\*.*?\*/", "", css[1], flags=re.S)
    header = masthead[0].replace("日报智能体 · 自动编印", "项目报告技能 · 证据编印").replace("周报智能体 · 自动编印", "项目报告技能 · 证据编印")
    if cadence == "monthly":
        header = re.sub(r'<div class="emblem">.*?</div>', SUN, header, count=1, flags=re.S)
        header = header.replace("米多智能体周刊", "米多项目月度读本").replace("MIDUO AGENT WEEKLY", "MIDUO PROJECT MONTHLY").replace("一周纵深读本", "月度交付事实参考").replace("项目报告技能 · 证据编印", "管理事实 · 本人表达独立保留")
        style += '\n:root{--indigo:#a16207}.emblem{color:#a16207}\n'
    return path, hashlib.sha256(text.encode()).hexdigest(), style, header


def render_edition(report, context=None, title=None):
    """Return a publishable edition and matching Markdown from canonical evidence.

    `context` is the weekly collector's six-source JSON. It supplies the daily
    trail and coverage appendix; its activity counters cannot alter delivery facts.
    """
    cadence = report["cadence"]
    if cadence not in {"daily", "weekly", "monthly"}:
        raise ValueError("未知刊物周期")
    context = context or {}
    path, digest, css, header = _template(cadence)
    label = {"daily": "日报", "weekly": "周报", "monthly": "月度管理事实参考"}[cadence]
    title = title or f"{label} · {report['start']} ~ {report['end']}"
    evidence = report.get("evidence", {})
    items = report.get("items", [])
    body, md = [], [f"# {_md(title)}", "", f"覆盖日期：{report['start']} ~ {report['end']}；时区：{report.get('timezone', 'Asia/Shanghai')}。", ""]
    summary = (f"按稳定事项持续跟踪 {len(items)} 件工作，功能、验证与上线分别核查。" if items else "证据不足：尚未取得可关联的工作事项，不能判断交付成果或风险。")
    milestone = ("本期首次里程碑：" + "；".join(f"{name}{report.get('newMilestones', {}).get(key, 0)} 项" for key, name in (("code", "功能完成"), ("validation", "验证完成"), ("release", "上线完成"))) + "。三项分别去重，不相加为成果总数。" if report.get("historyComplete") else "事项历史覆盖尚未核实，本期新增成果数不可用；首次采到不等于本期新增。")
    body.append(f'<section class="edition-summary"><h1>{_text(title)}</h1><p>{_text(summary)}</p><p>{_text(milestone)}</p></section>')
    md += [summary, "", milestone, ""]
    nav = [("risk", "风险与阻塞"), ("progress", "连续交付"), ("next", "下一步"), ("metrics", "效率与收益"), ("sources", "核查来源")]
    body.append('<p class="edition-nav">阅读顺序：' + ' · '.join(name for _, name in nav) + '。点击每项依据可在新窗口核查原始来源。</p>')

    def section(key, heading):
        body.append(f'<section class="edition-section" id="{key}"><h2>{heading}</h2>')
        md.extend([f"## {heading}", ""])

    section("risk", "风险与阻塞：先看需要处理的事")
    risky = [(item, *_risks(item, evidence)) for item in items if _risks(item, evidence)[0]]
    if not risky:
        message = "当前来源不足以确认是否存在其他风险；未采到风险记录不等于没有风险。"
        body.append(f'<p class="edition-warning">{message}</p>'); md += [message, ""]
    for item, reasons, refs in risky:
        severity = " edition-failure" if item["current"].get("validation") == "failed" or item["current"].get("release") == "failed" or _ci_failure(item, evidence) else ""
        body.append(f'<article class="edition-warning{severity}"><b>{_text(item["title"])}</b><p>{_text("；".join(reasons))}</p><p>{_links(refs, evidence)}</p></article>')
        md += [f"- **{_md(item['title'])}**：{_md('；'.join(reasons))}。{_md_links(refs, evidence)}", ""]
    # A failing report with missing scope/revision is still a management signal.
    # It cannot become a feature failure, but must not disappear into an appendix.
    for record in (context.get("acceptance") or {}).get("items", []):
        verdict = record.get("verdict")
        if verdict not in {"fail", "conditional"}:continue
        url = _source_link(record)
        label = "未通过" if verdict == "fail" else "有条件通过"
        text = f"验收来源{label}：{record.get('title') or record.get('id') or '无标题'}"
        explanation = "这是该报告的结论；事项、版本和验证范围仍须逐项核对，不据此扩大为整个功能失败或已完成。"
        link = f'<a href="{_text(url)}" target="_blank" rel="noopener noreferrer">核查验收原文</a>' if url else "缺少可访问深链，需补来源"
        body.append(f'<article class="edition-warning"><b>{_text(text)}</b><p>{explanation}</p><p>{link}</p></article>')
        md += [f"- **{_md(text)}**：{explanation} " + (f"[核查验收原文]({url})" if url else "缺少可访问深链，需补来源"), ""]
    for event in report.get("unassignedRisks", []):
        kind = event.get("kind")
        if kind == "validation_failed":
            text = "未关联事项的" + ("CI 检查失败" if event.get("scope") == "ci" else "功能验证失败记录")
        elif kind == "release_failed":
            text = "未关联事项的" + ("正式发布失败" if event.get("environment") == "production" else "预览部署失败（不等于正式发布失败）")
        else:
            text = "未关联事项的阻塞：" + str(event.get("reason") or "原因未提供")
        metadata = f"版本：{event.get('revision') or '未提供'}；范围：{event.get('scope') or event.get('environment') or '未提供'}；尚不能判断影响哪个事项，不计成果。"
        severity = " edition-failure" if kind in {"validation_failed", "release_failed"} else ""
        body.append(f'<article class="edition-warning{severity}" data-unassigned-risk="{_text(event["id"])}"><b>{_text(text)}</b><p>{_text(metadata)}</p><p>{_text(event.get("source", {}).get("excerpt") or "")}</p><p>{_links([event["id"]], evidence)}</p></article>')
        md += [f"- **{_md(text)}**：{_md(metadata)} {_md_links([event['id']], evidence)}", ""]
    for limitation in report.get("limitations", []):
        body.append(f'<p class="edition-warning">{_text(limitation)}</p>'); md += [f"- {_md(limitation)}", ""]
    body.append('</section>')
    section("progress", "连续交付：上期到本期的实际变化")
    if not items:
        body.append(f'<p class="edition-copy">{_text(summary)}</p>'); md += [summary, ""]
    for item in items:
        current, previous = item["current"], item.get("previous", {})
        body.append(f'<article class="edition-item" data-work-item-id="{_text(item["workItemId"])}"><p class="edition-meta">{_text(item.get("movement", ""))} · 事项 {_text(item["workItemId"])}</p><h3>{_text(item["title"])}</h3>')
        md += [f"### {_md(item['title'])}", "", f"事项：`{_md(item['workItemId'])}`；{_md(item.get('movement', ''))}。", ""]
        body.append('<div class="edition-phase-grid">')
        for key, name in (("code", "功能完成"), ("validation", "功能验证"), ("release", "正式上线")):
            status = current.get(key, "unknown"); before = LABELS.get(previous.get(key, "unknown"), "未证实")
            refs = current.get("evidence", {}).get(key, [])
            body.append(f'<div class="edition-phase"><span>{name}</span><strong class="st-{_text(status)}">{_text(LABELS.get(status, "未证实"))}</strong><p>上期：{_text(before)}</p><p>{_links(refs, evidence)}</p></div>')
            md.append(f"- {name}：{_md(before)} → **{_md(LABELS.get(status, '未证实'))}**。{_md_links(refs, evidence)}")
        body.append('</div>')
        body.append(f'<p class="edition-meta">当前版本：{_text(current.get("revision") or "未证实")} · 负责人：{_text(item.get("owner") or "待指定")}</p>')
        refs = item.get("periodEvidence", [])
        body.append((f'<details class="edition-sources"><summary>核查本期变化依据（{len(refs)}）</summary><p>{_links(refs, evidence)}</p></details>' if refs else '<p class="edition-copy">本期无新证据，延续跟踪。</p>') + '</article>')
        md += [f"当前版本：`{_md(current.get('revision') or '未证实')}`。", f"本期记录：{_md_links(refs, evidence) if refs else '无新证据，延续跟踪'}。", ""]
    body.append('</section>')
    section("next", "下一步：动作、执行人和期限")
    for item in items:
        action, owner, due = _next(item); refs = item.get("historyEvidence", [])
        body.append(f'<article class="edition-item"><h3>{_text(item["title"])}</h3><p class="edition-copy">{_text(action)}</p><p class="edition-meta">执行人：{_text(owner)} · 期限：{_text(due)}</p><details class="edition-sources"><summary>核查下一步依据（{len(refs)}）</summary><p>{_links(refs, evidence)}</p></details></article>')
        md += [f"- **{_md(item['title'])}**：{_md(action)}；执行人：{_md(owner)}；期限：{_md(due)}。{_md_links(refs, evidence)}", ""]
    if not items:
        body.append('<p class="edition-copy">先补充可核查的事项来源和负责人，再制定交付计划。</p>'); md += ["先补充可核查的事项来源和负责人，再制定交付计划。", ""]
    body.append('</section>')
    section("metrics", "效率、工时与收益：只采用明确测量")
    for key, name in (("efficiency", "效率变化"), ("hours", "工时"), ("benefit", "已实现收益")):
        metric = report.get("metrics", {}).get(key, {})
        if not metric.get("available"):
            text = f"{name}：不可用。{metric.get('reason') or '没有本周期可核查测量，不从提交数或代码量推算。'}"
            body.append(f'<p class="edition-copy">{_text(text)}</p>'); md += [f"- {_md(text)}", ""]
            continue
        measurement = metric["measurement"]
        text = f"{name}：{measurement['value']} {measurement['unit']}；方法：{measurement['method']}；样本：{measurement['population']}。"
        body.append(f'<article class="edition-item"><p>{_text(text)}</p>'); md += [f"- {_md(text)}"]
        comparison = metric.get("comparison")
        if comparison:
            text = f"相邻同口径周期差值：{comparison['delta']} {measurement['unit']}；不能仅据此归因于某项改动。"
            body.append(f'<p class="edition-copy">{_text(text)}</p>'); md.append(_md(text))
        else:
            body.append('<p class="edition-copy">没有相邻同口径测量，不判断升降。</p>'); md.append("没有相邻同口径测量，不判断升降。")
        for source in measurement.get("sources", []) + ((comparison or {}).get("previous", {}).get("sources", [])):
            url = _url(source.get("uri")); label_text = source.get("excerpt") or "测量来源"
            body.append('<p class="edition-copy">' + (f'<a href="{_text(url)}" target="_blank" rel="noopener noreferrer">{_text(label_text)}</a>' if url else _text(label_text)) + '</p>')
            md.append(f"来源：{_md(label_text)}" + (f" — {url}" if url else "（缺可访问链接）"))
        body.append('</article>'); md.append("")
    body.append('</section>')

    if cadence == "weekly":
        section("daily-trail", "一周脉络：逐日日报，不按提交量判断忙闲")
        daily = context.get("dailyReports") or {}
        body.append('<ol class="edition-trail">')
        for offset in range(7):
            day = (date.fromisoformat(report["start"]) + timedelta(days=offset)).isoformat()
            entries = [item for item in daily.get("items", []) if (item.get("date") or "")[:10] == day]
            body.append(f'<li><b>{day}</b>'); md.append(f"- **{day}**")
            if not daily.get("available"):
                text = "日报来源不可用：" + str(daily.get("reason") or "未提供日报来源")
                body.append(f'<p>{_text(text)}</p>'); md.append("  " + _md(text))
            elif not entries:
                body.append('<p>未采到对应日报，不代表当天没有工作。</p>'); md.append("  未采到对应日报，不代表当天没有工作。")
            for entry in entries:
                url = _source_link(entry); text = entry.get("title") or "当日日报"
                body.append('<p>' + (f'<a href="{_text(url)}" target="_blank" rel="noopener noreferrer">{_text(text)}</a>' if url else _text(text) + "（缺少可访问深链）") + '</p>')
                md.append("  " + (f"[{_md(text)}]({url})" if url else _md(text) + "（缺少可访问深链）"))
            body.append('</li>')
        body.append('</ol></section>'); md.append("")

    section("coverage", "来源覆盖与活动附录")
    body.append('<p class="edition-copy">以下说明采集覆盖。提交、调用、日报篇数、验收报告份数和预览部署记录均不等于交付成果，不能用来推算效率。</p><div class="edition-source-status">')
    md += ["以下仅说明采集覆盖与活动，不能据此推算交付成果或效率。", ""]
    for key, name in SOURCE_NAMES.items():
        source = context.get(key) or {}
        text = "可读取；仅作来源覆盖说明" if source.get("available") else "不可用：" + str(source.get("reason") or "未提供该来源")
        if key == "acceptance" and source.get("unclassifiedCount"):
            text += f'；另保留{source["unclassifiedCount"]}条未确认为功能验收的材料，不计入验收或成果。'
        body.append(f'<div><b>{name}</b><p>{_text(text)}</p></div>'); md.append(f"- {name}：{_md(text)}。")
    body.append('</div>')
    for key, name in {**SOURCE_NAMES, "previewDeploys": "分支预览部署（不是正式上线）"}.items():
        source = context.get(key) or {}
        records = source.get("items") if source.get("available") is True else None
        if not isinstance(records, list) or not records:
            continue
        body.append(f'<details class="edition-sources"><summary>{name}原始记录（{len(records)}，不计为交付成果）</summary><ol>')
        md += [f"### {name}原始记录（不计为交付成果）", ""]
        for record in records:
            if not isinstance(record, dict):
                continue
            text = record.get("title") or record.get("name") or record.get("id") or "来源记录"
            url = _source_link(record)
            metadata = " · ".join(str(record[field]) for field in ("date", "createdAt", "verdict", "status", "commitSha") if record.get(field) is not None)
            body.append('<li>' + (f'<a href="{_text(url)}" target="_blank" rel="noopener noreferrer">{_text(text)}</a>' if url else _text(text) + "（缺少可访问深链）") + f'<p class="edition-meta">原始记录：{_text(metadata or "元数据未提供")}；不自动升级为功能、验证或上线完成。</p></li>')
            md += ["- " + (f"[{_md(text)}]({url})" if url else _md(text) + "（缺少可访问深链）"), "  原始记录：" + _md(metadata or "元数据未提供") + "；不自动升级为功能、验证或上线完成。"]
        body.append('</ol></details>');md.append("")
    count = len(report.get("unassignedEvidence", []))
    text = f"本期未归属来源记录 {count} 条，不计成果，不按标题猜测关联。"
    body.append(f'<p class="edition-warning">{text}</p>'); md += ["", text, ""]
    body.append('</section>')
    section("sources", "核查来源与完整历史")
    for eid, event in evidence.items():
        source = event.get("source") or {}; url = _url(source.get("uri")); excerpt = source.get("excerpt") or "来源原文缺失"
        body.append(f'<article class="edition-sources" id="{_text(_anchor(eid))}"><p class="edition-meta">{_text(eid)} · {_text(event.get("occurredAt"))} · {_text(event.get("kind"))} · {_text(event.get("revision") or "无版本")}</p><p>{_text(excerpt)}</p>')
        if url:
            body.append(f'<p><a href="{_text(url)}" target="_blank" rel="noopener noreferrer">打开原始来源</a></p>')
        else:
            body.append(f'<p>{_text(source.get("uri") or "无来源地址")}（非公开来源，仅供明确标注的回归样本）</p>')
        if event.get("timeBasis") == "observed":
            body.append('<p>这是证据观测时间，不能当作完成发生时间。</p>')
        body.append('</article>')
        md += [f'<a id="{_anchor(eid)}"></a>', f"- `{_md(eid)}` · {_md(event.get('occurredAt'))} · {_md(event.get('kind'))} · `{_md(event.get('revision') or '无版本')}` · {'证据观测时间，不计完成发生时间' if event.get('timeBasis') == 'observed' else '事实发生时间'}", f"  {_md(excerpt)}", f"  {url or _md(source.get('uri') or '无来源地址')}", ""]
    body.append('</section>')
    monthly = "评价、认可、建议及提交由员工本人完成；本刊只提供管理事实参考，不自动代填或提交个人月报。"
    body.append(f'<p class="edition-warning">{monthly}</p>'); md += [monthly, ""]
    context_digest = hashlib.sha256(json.dumps(context, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    relative = path.relative_to(ROOT).as_posix()
    body.append(f'<footer class="edition-footer">事实输入摘要：{_text(report.get("inputDigest"))}<br>采集上下文摘要：{context_digest}<br>原技能模板：{_text(relative)} · {digest}</footer>')
    md += [f"事实输入摘要：`{report.get('inputDigest', '')}`", f"采集上下文摘要：`{context_digest}`", f"原技能模板：`{relative}` · `{digest}`", ""]
    document = f'<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>{_text(title)}</title><style>{css}\n{CSS}</style></head><body><div class="paper" data-edition-template="v1" data-template-digest="{digest}">{header}<div class="dateline"><span>{_text(report["start"])} 至 {_text(report["end"])} · {_text(report.get("timezone", "Asia/Shanghai"))}</span><span>按事项核查 · 三阶段独立 · 证据不足保留未知</span></div>{"".join(body)}</div></body></html>'
    return {"markdown": "\n".join(md), "html": document, "templatePath": relative, "templateDigest": digest, "contextDigest": context_digest}
