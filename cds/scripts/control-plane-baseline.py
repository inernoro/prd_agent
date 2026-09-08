#!/usr/bin/env python3
"""控制面过载治理的度量尺（2026-09-08）。

改前改后用同一把尺子量，输出一张 Markdown 表。只读 CDS API，不改任何状态。
用法：CDS_HOST=cds.miduo.org AI_ACCESS_KEY=... python3 cds/scripts/control-plane-baseline.py [--hours 24]
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import os
import subprocess
import sys


def api(path: str, timeout: int = 90):
    # 走 curl 而不是 urllib：Agent 沙箱的出站代理与 CA 配置对 curl 已就绪，urllib 不一定。
    host = os.environ.get("CDS_HOST", "").strip()
    if not host:
        sys.exit("CDS_HOST 未设置")
    if not host.startswith("http"):
        host = "https://" + host
    # 密钥不进 argv（共享宿主上 /proc/*/cmdline 可读）：用 `-K -` 让 curl 从 stdin 读配置。
    key = os.environ.get("AI_ACCESS_KEY", "").replace('"', "")
    r = subprocess.run(
        ["curl", "-sS", "--max-time", str(timeout), "-K", "-", host + path],
        input=f'header = "X-AI-Access-Key: {key}"\n',
        capture_output=True, text=True, check=False,
    )
    if r.returncode != 0:
        sys.exit(f"curl {path} 失败: {r.stderr.strip()[:200]}")
    return json.loads(r.stdout)


def parse_ts(s: str) -> dt.datetime:
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))


RUNS_API_CAP = 200


def runs_window_truncated(dated_count: int, in_window_count: int, cap: int = RUNS_API_CAP) -> bool:
    """窗口内的部署次数是不是被接口条数上限截断了。

    /api/deployment-runs 把 limit 夹到 cap 且没有翻页游标。拿满 cap 条、而且这 cap 条
    全都落在窗口内，就说明窗口比接口能给的更长——真实次数只多不少，数字得标成下界。
    没拿满，或者里面已经有比窗口更老的记录（说明窗口的边界在返回结果之内），就没被截断。
    """
    return dated_count >= cap and in_window_count > 0 and in_window_count == dated_count


def _self_test() -> None:
    """判据自检：`--self-test` 跑一次，不打任何接口。"""
    cases = [
        # (拿到的有日期记录数, 落在窗口内的数, 期望)
        ((200, 200), True),    # 拿满且全在窗口内 → 截断
        ((200, 143), False),   # 拿满但有更老的记录 → 窗口边界可见，没截断
        ((143, 143), False),   # 没拿满 → 没截断
        ((200, 0), False),     # 拿满但窗口内一条都没有 → 谈不上截断
        ((0, 0), False),       # 空
    ]
    for (dated, in_window), expected in cases:
        got = runs_window_truncated(dated, in_window, cap=200)
        assert got is expected, f"runs_window_truncated({dated}, {in_window}) = {got}, 期望 {expected}"
    print("self-test ok: runs_window_truncated 5 组判据通过")


def pct(sorted_vals, p):
    if not sorted_vals:
        return 0
    return sorted_vals[min(len(sorted_vals) - 1, int(len(sorted_vals) * p))]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=int, default=24)
    ap.add_argument("--self-test", action="store_true", help="只跑判据自检，不打任何接口")
    args = ap.parse_args()
    if args.self_test:
        _self_test()
        return
    now = dt.datetime.now(dt.timezone.utc)
    since = (now - dt.timedelta(hours=args.hours)).strftime("%Y-%m-%dT%H:%M:%SZ")
    rows: list[tuple[str, str]] = []

    host = api("/api/host-stats")
    rows.append(("宿主 load1 / load5 / load15（核数）", f"{host['cpu']['loadAvg1']} / {host['cpu']['loadAvg5']} / {host['cpu']['loadAvg15']}（{host['cpu']['cores']} 核）"))
    rows.append(("内存已用", f"{host['mem']['usedPercent']}%"))

    usage = api("/api/cds-system/resource-usage")
    tot = usage.get("totals") or {}
    rows.append(("托管容器数 / 容器 CPU 合计", f"{tot.get('runningContainers')} / {tot.get('cpuPercent')}%"))

    health = api("/healthz")
    pressure = health.get("pressure") or {}
    if pressure:
        el = pressure.get("eventLoop", {}).get("current", {})
        rows.append(("master 事件循环 p50 / p99 / max", f"{el.get('p50Ms')} / {el.get('p99Ms')} / {el.get('maxMs')} ms"))
        cg = pressure.get("workloadCgroup", {})
        rows.append(("托管容器 cgroup 权重接管", f"{cg.get('weightManaged')}（driver={cg.get('driver')}）"))
        noise = pressure.get("webhookNoise") or {}
        rows.append((
            "webhook 噪声已压掉（进程启动以来）/ 这批仍占用 master",
            f"{noise.get('suppressedTotal')} 条 / {round((noise.get('suppressedDurationMs') or 0) / 1000, 1)} s",
        ))
        audit = pressure.get("offhostAudit") or {}
        rows.append(("离机审计熔断", f"open={audit.get('open')} 连续失败={audit.get('consecutiveFailures')} 跳过={audit.get('skippedWhileOpen')}"))
        rows.append(("控制面告警", "；".join(w["code"] for w in pressure.get("warnings", [])) or "无"))
    else:
        rows.append(("/healthz pressure", "旧版本无此字段（改前）"))

    up = api("/api/uptime/summary")
    last = up.get("lastCycleAt")
    age_min = None if not last else round((now.timestamp() * 1000 - last) / 60000)
    rows.append(("探活监控上一轮距今", f"{age_min} 分钟" if age_min is not None else "无"))

    # master 层最近 N 小时的慢端点：一直翻到时间边界（拿到短页即到底），不再固定 4 页。
    # 固定页数会在高流量窗口静默只分析最新子集，而那恰恰是要对比的过载时段
    # ——webhook 计数、部署/删除/列表分位数会一起偏（Codex 八轮 P2）。
    # 仍留一个页数上限防跑飞；真撞上就把由 logs 派生的指标标成下界。
    MAX_LOG_PAGES = 40
    logs = []
    until = None
    logs_truncated = False
    for page_index in range(MAX_LOG_PAGES):
        q = f"/api/http-logs?since={since}&layer=master&limit=5000&sort=recent" + (f"&until={until}" if until else "")
        page = api(q).get("logs", [])
        if not page:
            break
        logs.extend(page)
        until = page[-1]["ts"]
        if len(page) < 5000:
            break
        if page_index == MAX_LOG_PAGES - 1:
            logs_truncated = True
    log_mark = "≥" if logs_truncated else ""
    log_note = f"（已翻 {MAX_LOG_PAGES} 页仍未到窗口边界，实际更多）" if logs_truncated else ""
    seen = {}
    for l in logs:
        seen[l["_id"]] = l
    logs = list(seen.values())
    # 口径警告：改后被廉价 ack 的噪声不写 HTTP 日志，不在这一行里。只看这行会把
    # 「不再观测」读成「不再耗时」，于是对比虚高（Codex 四轮 P2）。上面那行
    # 「webhook 噪声已压掉 / 这批仍占用 master」是内存里如实记的账，两行合起来看才是
    # 真实的改前改后：改前 = 本行；改后 = 本行 + 被压掉那行。
    wh = [l for l in logs if l["path"].startswith("/api/github/webhook")]
    wh_ms = sum(l["durationMs"] for l in wh)
    rows.append((f"webhook 投递数（{args.hours}h 采样，仅记录在案的）/ 占用 master 时间", f"{log_mark}{len(wh)} / {log_mark}{round(wh_ms / 1000)} s{log_note}"))
    deploys = sorted(l["durationMs"] for l in logs if l["method"] == "POST" and l["path"].rstrip("/").endswith("/deploy"))
    rows.append(("部署请求 p50 / p95 / max", f"{pct(deploys, .5) // 1000} / {pct(deploys, .95) // 1000} / {(deploys[-1] // 1000) if deploys else 0} s（n={log_mark}{len(deploys)}{log_note}）"))
    deletes = sorted(l["durationMs"] for l in logs if l["method"] == "DELETE" and "/api/branches/" in l["path"])
    rows.append(("删分支请求 p50 / max", f"{pct(deletes, .5) // 1000} / {(deletes[-1] // 1000) if deletes else 0} s（n={log_mark}{len(deletes)}{log_note}）"))
    branches_get = sorted(l["durationMs"] for l in logs if l["method"] == "GET" and l["path"].split("?")[0] in ("/api/branches", "/_cds/api/branches") and l["status"] == 200)
    rows.append(("分支列表接口 p50 / p95（页面首屏数据）", f"{pct(branches_get, .5)} / {pct(branches_get, .95)} ms（n={log_mark}{len(branches_get)}{log_note}）"))

    # 同 runs 那条：/api/http-logs 单次最多给 5000 条。重连风暴恰恰是最容易撑满的时候，
    # 不声张地少算会让改前改后对比虚高，所以拿满就把数字标成下界（Codex 七轮 P2）。
    HTTP_LOG_CAP = 5000
    fwd = api(f"/api/http-logs?since={since}&layer=forwarder&minStatus=500&limit={HTTP_LOG_CAP}").get("logs", [])
    fwd_mark = "≥" if len(fwd) >= HTTP_LOG_CAP else ""
    fwd_note = f"（受接口 {HTTP_LOG_CAP} 条上限截断，实际更多）" if fwd_mark else ""
    sse = [l for l in fwd if l.get("requestKind") == "sse"]
    rows.append((f"dashboard SSE 断连（forwarder 5xx，{args.hours}h）", f"{fwd_mark}{len(sse)}{fwd_note}"))
    non_sse = [l for l in fwd if l.get("requestKind") != "sse" and "/_cds/" in l["path"]]
    rows.append((f"dashboard 接口 5xx（非 SSE，{args.hours}h）", f"{fwd_mark}{len(non_sse)}{fwd_note}"))

    # /api/deployment-runs 把 limit 夹到 200 且没有翻页游标：窗口内超过 200 次部署时
    # 只能看到最新的 200 条。不声张地少算会让长窗口的改前改后对比失真，所以这里显式
    # 判断有没有被截断，被截断就把数字标成下界（Codex 五轮 P2）。
    runs = api(f"/api/deployment-runs?limit={RUNS_API_CAP}")
    runs = runs.get("runs") if isinstance(runs, dict) else runs
    cutoff = now - dt.timedelta(hours=args.hours)
    dated = [r for r in runs if r.get("startedAt")]
    r24 = [r for r in dated if parse_ts(r["startedAt"]) >= cutoff]
    truncated = runs_window_truncated(len(dated), len(r24))
    mark = "≥" if truncated else ""
    note = f"（受接口 {RUNS_API_CAP} 条上限截断，实际更多）" if truncated else ""
    st = collections.Counter(r.get("status") for r in r24)
    top = collections.Counter(r.get("branchId") for r in r24).most_common(3)
    rows.append((
        f"部署次数（{args.hours}h）/ 失败 / 取消",
        f"{mark}{len(r24)} / {mark}{st.get('failed', 0)} / {mark}{st.get('cancelled', 0)}{note}",
    ))
    rows.append(("部署最多的分支", ("；".join(f"{b} x{mark}{n}" for b, n in top) or "无") + note))

    dock = api("/api/server-events?limit=1000&category=docker").get("events", [])
    if dock:
        span_h = max(1 / 60, (parse_ts(dock[0]["ts"]) - parse_ts(dock[-1]["ts"])).total_seconds() / 3600)
        dies = [e for e in dock if e.get("action") == "die"]
        rows.append(("容器死亡事件速率", f"{round(len(dies) / span_h)} 次/小时（最近 {len(dock)} 条 docker 事件跨 {span_h:.1f} h）"))
    sysev = api("/api/server-events?limit=1000&category=system").get("events", [])
    if sysev:
        span_m = max(1, (parse_ts(sysev[0]["ts"]) - parse_ts(sysev[-1]["ts"])).total_seconds() / 60)
        off = sum(1 for e in sysev if e.get("action") == "offhost.audit.write.failed")
        rows.append(("审计外发失败事件速率", f"{off / span_m:.1f} 条/分钟（最近 1000 条系统事件跨 {span_m:.0f} 分钟）"))

    print(f"| 指标 | {now.strftime('%Y-%m-%d %H:%M')} UTC |")
    print("|---|---|")
    for k, v in rows:
        print(f"| {k} | {v} |")


if __name__ == "__main__":
    main()
