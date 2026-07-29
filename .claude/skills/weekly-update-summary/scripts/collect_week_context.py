#!/usr/bin/env python3
"""
周报关联产物采集器（weekly-update-summary 纪律 9/10/11 的数据底座）。

git 只能回答「改了什么代码」，回答不了老板/产品经理真正要问的四件事：
  1. 这一周每天到底发生了什么（-> 日报知识库）
  2. 做完的东西验没验、验没验过（-> CDS 验收中心的 verdict）
  3. 质量在变好还是变差（-> 缺陷台账）
  4. 有没有真的发到线上（-> CDS 正式发布台账 /api/releases/runs，注意不是分支部署版本）

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
import argparse, contextlib, json, os, re, subprocess, sys, time
from urllib.parse import quote as _urlquote

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


def _cdscli_path():
    repo = os.environ.get("CDSCLI_REPO_ROOT", ".")
    cli = os.path.join(repo, CDSCLI)
    if not os.path.exists(cli):
        raise RuntimeError(f"找不到 cdscli：{cli}")
    return cli


def _cdscli(args):
    """所有 CDS 读取都过 cdscli：它是凭据与 URL 的 SSOT，禁止本脚本自己拼 host。"""
    env = dict(os.environ, CDSCLI_NO_DRIFT_CHECK="1")
    r = subprocess.run([sys.executable, _cdscli_path()] + args, capture_output=True, text=True,
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


_CDSCLI_MOD = None


@contextlib.contextmanager
def _cdscli_stdout_guard():
    """把 cdscli 在**本进程内**的打印全部改道 stderr。

    cdscli 的 `die()` 先往 stdout 打一行 `{"ok": false, ...}` 再 sys.exit。我们是 import
    它、直接调它的内部函数，那行 JSON 就落进了本采集器的 stdout —— 而本脚本的 stdout
    必须是**一份**可被 json.load 直接吃掉的 JSON。CDS 一不可达（缺 CDS_HOST / 缺项目凭据）
    输出就变成两段 JSON 拼接，下游解析直接炸 "Extra data"，把「某个来源降级」放大成
    「整份上下文不可用」。诊断信息不能丢，所以是改道 stderr 而不是丢进 devnull。
    子进程路径（_cdscli）不受影响：那边本来就 capture_output。
    """
    with contextlib.redirect_stdout(sys.stderr):
        yield


def _cds_api(path):
    """
    读 cdscli 尚未包装成子命令的 CDS 端点（如正式发布台账 /api/releases/runs）。

    仍然复用 cdscli 的 `_request`——host、凭据、重试全部走它那一套，本脚本不碰 URL 拼装，
    符合 CLAUDE.md 规则 11「不自己 slugify / 不猜 host」的实质要求。等 cdscli 补了
    `release` 子命令，这里换成 _cdscli(["release", "list"]) 即可。

    两件事必须自己做，因为我们是 import 模块而不是跑它的 main()：
    1. 显式调 `_load_local_credentials()`。项目级 `.cds/credentials.json` 是标准接入方式，
       平时由 main() 负责加载；只 import 的话本进程既没有 CDS_HOST 也没有项目 key，
       `_cds_base()` 会直接 die。
    2. 传 `fatal_network_errors=False` 并把 SystemExit 翻成普通异常。cdscli 的 `die()`
       走 `sys.exit()`，抛的是 BaseException 子类，调用方的 `except Exception` 接不住，
       CDS 一不可达就会把整个采集器带走——那正好违背「每个来源独立降级」的设计。
    """
    global _CDSCLI_MOD
    if _CDSCLI_MOD is None:
        import importlib.util
        spec = importlib.util.spec_from_file_location("cdscli_mod", _cdscli_path())
        mod = importlib.util.module_from_spec(spec)
        saved = sys.argv
        sys.argv = ["cdscli"]                      # 防模块顶层 argparse 吃到本脚本参数
        try:
            with _cdscli_stdout_guard():
                spec.loader.exec_module(mod)
        except SystemExit:
            pass
        finally:
            sys.argv = saved
        try:
            with _cdscli_stdout_guard():
                mod._load_local_credentials()      # 注入 .cds/credentials.json 到本进程
        except Exception:
            pass                                   # 没有项目级凭据时靠环境变量，交由下面报错
        except SystemExit:
            pass                                   # die() 抛的是 BaseException，Exception 接不住
        _CDSCLI_MOD = mod

    try:
        with _cdscli_stdout_guard():
            status, body, _ = _CDSCLI_MOD._request("GET", path, fatal_network_errors=False)
    except SystemExit as e:                        # _cds_base() 等处缺 host/凭据时 die()
        raise RuntimeError(f"cdscli 无法请求 {path}（缺 CDS_HOST 或项目凭据？exit={e.code}）") from None
    if status == 0:
        raise RuntimeError(f"CDS {path} 网络不可达：{(body or {}).get('message') or (body or {}).get('error')}")
    if status != 200:
        raise RuntimeError(f"CDS {path} 返回 {status}")
    return body


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

    # all=true 必须带：ListEntries 在 all=false 时只返回根层级（ParentId==null），
    # 日报一旦被归进文件夹就会被静默漏掉，然后被误报成「当天没有日报」。
    entries, page = [], 1
    while True:
        res = _curl(H + [f"{base}{API}/stores/{sid}/entries?page={page}&pageSize=200&all=true&excludeFolders=true"])
        data = res.get("data") or {}
        items = data.get("items") or []
        entries += items
        if len(entries) >= (data.get("total") or 0) or not items:
            break
        page += 1
        if page > 50:
            break

    # entryId -> 分享 token，用于给非登录读者一个可点开的链接。
    # 必须同时排除已撤销与已过期：匿名端点对过期 token 直接 404，
    # 发一条打不开的链接比不发更糟（周报会声称「有深链」而读者点开是错误页）。
    tok = {}
    try:
        import datetime as _dt
        now = _dt.datetime.now(_dt.timezone.utc)
        sl = _curl(H + [f"{base}{API}/stores/{sid}/share-links"])
        for l in ((sl.get("data") or {}).get("items") or []):
            if not l.get("entryId") or l.get("isRevoked"):
                continue
            exp = (l.get("expiresAt") or "").strip()
            if exp:
                try:
                    if _dt.datetime.fromisoformat(exp.replace("Z", "+00:00")) <= now:
                        continue                    # 已过期，跳过
                except Exception:
                    pass                            # 解析不了就不当过期处理，交由读者实际点击暴露
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


# ── 来源 4：线上发布（正式发布台账，回答「有没有真的发出去」） ────────────
# 注意：不能用 deployment-version。任何分支部署成功后 CDS 都会生成不可变部署版本
# （cds/src/routes/branches.ts 的 version-create），分支预览也算在内——拿它当
# 「线上发布次数」会把预览部署充成正式发布，把数字吹大好几倍。正式发布的唯一台账
# 是 /api/releases/runs。
#
# 状态口径抄 CDS 的 SSOT（cds/src/services/release-retention.ts）：
#   终态 = success / failed / rollback_success / rollback_failed
#   在途 = queued / running / healthchecking / rollback_running
# 在途 run 必须排除出成功率分母，否则会出现「1 次尝试 / 0 成功 / 0 失败 / 0%」这种自相矛盾。
# rollback_* 单独报：CDS 把 rollback_success 计为「run 成功」，但对业务读者，
# 「发上去又回滚了」不能算一次成功发布，混进成功数会掩盖线上事故。
RELEASE_TERMINAL = {"success", "failed", "rollback_success", "rollback_failed"}


def _resolve_project_identity(project):
    """把 --project 解析成 (全部可能写法的小写集合, CDS 规范 id, 警告)。

    两个返回值各有用途，不能只留一个：

    - **集合**用于客户端比对。CDS 各端点对 `projectId` 字段的填法并不统一——
      `/api/releases/runs` 里存的是 slug（实测 `prd-agent`），而 `cdscli project list`
      返回的是 hex id（`defd4695ab5f`）。先前把入参归一成 hex id 再逐条比对，结果是
      W30 的 39 条 run 被**全部过滤掉**，却仍以 `available=true` + `attempts=0` 的姿态
      输出——静默的错误统计，比直接报错危险得多。所以不赌哪一种是「规范」写法，
      三种标识全收进集合，命中任意一个即算本项目。
    - **规范 id** 用于服务端 `?project=` 查询。项目级凭据下 CDS 会把该参数与 key 绑定的
      projectId **精确比对**，不一致直接 403；此时传调用方的原始写法（slug / 项目名）
      会让整个来源变成不可用，连回退都跑不到。所以查询一律用解析出的规范 id。

    解析失败时退化为「只认原始入参」，并由调用方在 note 里说明。
    """
    if not project:
        return None, None, None
    raw = project.strip().lower()
    try:
        res = _cdscli(["project", "list"])
        if not res.get("ok"):
            return {raw}, None, "项目列表不可用，仅按入参原值过滤"
        data = res.get("data")
        items = data if isinstance(data, list) else (data or {}).get("projects") or []
        for p in items:
            ident = {str(p.get(k, "")).strip().lower()
                     for k in ("id", "slug", "name")}
            ident.discard("")
            if raw in ident:
                return ident, (str(p.get("id") or "").strip() or None), None
        return {raw}, None, f"项目 {project} 未在 CDS 项目列表命中，仅按入参原值过滤"
    except Exception as e:
        return {raw}, None, f"项目标识解析失败（{str(e)[:80]}），仅按入参原值过滤"


# CDS 会裁剪发布台账：每个发布目标最多留 100 条 run，且超过 90 天的会被淘汰
# （cds/src/services/release-retention.ts 的 MAX_RELEASE_RUNS_PER_TARGET /
#  RELEASE_RUN_RETENTION_MS，写入时由 StateService.addReleaseRun 触发）。
# 因此补写历史周（Phase 1.5 回补最多 6 周）时台账可能已经不全，而繁忙目标even在
# 6 周窗口内也可能被条数闸削掉。不能默认「拿到的就是全部」——必须自己判覆盖完整性，
# 否则会以 available=true 的姿态给出被低估的发布次数与成功率。
RELEASE_MAX_RUNS_PER_TARGET = 100
RELEASE_RETENTION_DAYS = 90


def _release_coverage(all_runs, sel_runs, start, end):
    """判断本周区间是否落在台账仍完整保留的范围内。

    分两档，别混用：
    - warnings：**确定性**的丢数信号，会把 coverage.complete 打成 false，
      逼报告把本段数字写成下限。只有真的可能丢行才允许进这一档。
    - advisories：可能有风险但**不足以断定丢了行**的观察（如某目标 run 数逼近条数闸）。
      照常输出给读者提醒，但不改 complete —— 否则准确数据会被误标成下限。
    """
    import datetime as dt
    warns, advisories = [], []
    today = dt.date.today()
    # 必须拿**周起点**跟保留边界比，不是周终点：跨边界的那一周（如起点 93 天前、
    # 终点 87 天前）前几天的记录已可被淘汰，只看终点会漏判成 complete。
    # 用 >= 不是 >：CDS 的淘汰线是滚动的 90*24h（毫秒级），而这里只有日期粒度。
    # 起点正好是 90 天前那天时，该天清晨的 run 已经越过滚动线可被删，日期减法却只得 90。
    if (today - dt.date.fromisoformat(start)).days >= RELEASE_RETENTION_DAYS:
        warns.append(f"本周起点已触及 {RELEASE_RETENTION_DAYS} 天保留窗口边界，早于边界的 run 可能已被淘汰")
    dates = sorted(d for d in ((r.get("startedAt") or "")[:10] for r in all_runs) if d)
    oldest = dates[0] if dates else None
    # 注意：不能用「oldest > start」推断被裁剪。新项目的首次发布本来就可能晚于周起点，
    # 那是真实的「当时还没有发布」，不是记录被删——照此告警会把准确数据误标成不完整。
    # 条数闸同理：`n == 上限` 只说明**恰好装满**，不等于发生过淘汰（第 101 条从未存在过
    # 的新目标也满足），而 CDS 又不回传「删了多少条」这类真实淘汰信号。所以条数闸一律
    # 只作提示（advisory），不作丢数判据。
    per_target = {}
    for r in all_runs:
        k = r.get("targetId")
        dts = (r.get("startedAt") or "")[:10]
        e = per_target.setdefault(k, {"n": 0, "oldest": None})
        e["n"] += 1
        if dts and (e["oldest"] is None or dts < e["oldest"]):
            e["oldest"] = dts
    at_cap = [k for k, e in per_target.items()
              if e["n"] >= RELEASE_MAX_RUNS_PER_TARGET and e["oldest"] and e["oldest"] > start]
    if at_cap:
        advisories.append(f"{len(at_cap)} 个发布目标 run 数已达 {RELEASE_MAX_RUNS_PER_TARGET} 条上限"
                          f"且现存最早记录晚于本周起点 {start}；CDS 不回传淘汰计数，"
                          f"无法断定本周是否丢行，仅作提示")
    return {
        "complete": not warns,
        "warnings": warns,
        "advisories": advisories,
        "oldestRetainedDate": oldest,
        "retentionDays": RELEASE_RETENTION_DAYS,
        "maxRunsPerTarget": RELEASE_MAX_RUNS_PER_TARGET,
    }


def collect_releases(project, start, end):
    ident, canonical_id, resolve_warn = _resolve_project_identity(project)

    def _mine(r):
        p = r.get("projectId")
        if not ident or p is None:      # 未指定项目，或 run 未标项目 -> 一律收
            return True
        return str(p).strip().lower() in ident

    # 优先让**服务端**按项目过滤（/api/releases/runs 支持 ?project=）。
    # 这样「本项目一次都没发过」与「标识写法对不上」不再混为一谈：前者服务端直接返回空。
    # 之前靠「全量拉回来再客户端过滤，滤空就判定标识不匹配」是错的——实测 mdimp 就是
    # 真的一次没发过，而台账里那 136 条属于 prd-agent，那条守卫会把正确的「0 次」误报成
    # 「数据不可用」。
    #
    # 查询参数必须用**解析出的规范 id**，不能用调用方原始写法：项目级凭据下 CDS 把该
    # 参数与 key 绑定的 projectId 精确比对，不一致直接 403 —— 而 403 会让 _cds_api 抛错、
    # 整个来源变不可用，连下面的回退都跑不到。
    scope_warn = None
    scope_key = canonical_id or project
    q = "/api/releases/runs"
    if project:
        q += "?project=" + _urlquote(str(scope_key))
    try:
        runs = ((_cds_api(q) or {}).get("runs")) or []
    except Exception as e:
        # 带 scope 的查询失败（403 / 端点不支持该参数 / 其它）不该拖垮整个来源：
        # 退回不带 scope 的全量查询 + 客户端匹配，并如实告警。
        scope_warn = (f"服务端 ?project={scope_key} 查询失败（{str(e)[:80]}），"
                      f"已回退到全量查询 + 客户端按标识匹配")
        runs = [r for r in (((_cds_api("/api/releases/runs") or {}).get("runs")) or []) if _mine(r)]
    if project and not runs and not scope_warn:
        # 空结果有两种可能：真的没发过，或**传进去的写法服务端不认**。
        # 实测该端点只认 run 里存的那个 projectId 字面量（本仓库是 slug `prd-agent`），
        # 传项目名 `MAP` 或 hex id 一律返回 0 —— 直接信这个 0 等于把静默错误从客户端
        # 搬到服务端。故再拉一次全量做交叉验证：全量里若有属于本项目标识的 run，
        # 说明刚才那个写法没被认出来，回退到客户端匹配并告警。
        allruns = ((_cds_api("/api/releases/runs") or {}).get("runs")) or []
        fallback = [r for r in allruns if _mine(r)]
        if fallback:
            runs = fallback
            scope_warn = (f"服务端 ?project={project} 未命中，已回退到客户端按标识匹配"
                          f"（命中 {len(fallback)} 条）。该端点只认 run 里存的 projectId 字面量，"
                          f"建议改传 {sorted(ident) if ident else project} 中被台账实际使用的那个写法")
    scoped_all = [r for r in runs if _mine(r)]
    sel = []
    for r in runs:
        if not _mine(r):
            continue
        # 正式发布 run 用 startedAt 记时（该模型没有 createdAt）
        if not _in_week(r.get("startedAt") or "", start, end):
            continue
        sel.append({
            "releaseId": r.get("releaseId"),
            "date": (r.get("startedAt") or "")[:10],
            "status": r.get("status"),
            "commitSha": (r.get("commitSha") or "")[:7] or None,
            "projectId": r.get("projectId"),
        })
    sel.sort(key=lambda x: x["date"])

    def n(*st):
        return sum(1 for x in sel if x["status"] in st)

    terminal = [x for x in sel if x["status"] in RELEASE_TERMINAL]
    attempts = len(terminal)
    success, failed = n("success"), n("failed")
    rb_ok, rb_fail = n("rollback_success"), n("rollback_failed")
    in_flight = len(sel) - attempts
    out = {
        "available": True, "items": sel,
        "attempts": attempts,               # 仅终态，成功率分母
        "success": success,
        "failed": failed,
        "rollbackSuccess": rb_ok,
        "rollbackFailed": rb_fail,
        "rolledBack": rb_ok + rb_fail,
        "inFlight": in_flight,              # 采集时点仍在跑，单列不进分母
        "successRate": round(success * 100.0 / attempts, 1) if attempts else None,
        "note": "口径为正式发布台账 /api/releases/runs（不是分支预览部署）。"
                "成功率分母只含终态 run（success/failed/rollback_success/rollback_failed），"
                "在途 run 单列 inFlight；回滚单列 rolledBack——CDS 把 rollback_success 记为"
                "「run 成功」，但对业务而言「发上去又回滚」不算一次成功发布。"
                "同一次发布的多次重试各算一条 run。",
    }
    out["coverage"] = _release_coverage(scoped_all, sel, start, end)
    if scope_warn:
        # 回退路径本身不影响数字正确性（客户端匹配已命中），但要让读者知道口径怎么来的
        out["coverage"]["advisories"].append(scope_warn)
    if not out["coverage"]["complete"]:
        out["note"] += "【覆盖不完整】" + "；".join(out["coverage"]["warnings"]) + \
                       "——本段数字为下限，报告须注明口径。"
    if out["coverage"]["advisories"]:
        # 提示档：照常告知读者，但**不**声称数字是下限（未确认丢行）
        out["note"] += "【提示】" + "；".join(out["coverage"]["advisories"]) + "。"
    if resolve_warn:
        out["projectResolveWarning"] = resolve_warn
        # 标识解析没成功（项目列表拿不到 / 项目没命中）时，ident 只剩入参原值。
        # 若入参是别名（如项目名 MAP），台账里存的 `prd-agent` 就既不会被服务端 scope
        # 命中、也不会被客户端匹配命中 —— 这时的 0 是「没找着」，不是「没发过」，
        # 不能盖章认证。只有**解析成功**时的 0 才可信（mdimp 那种真实的零发布）。
        if not sel:
            out["available"] = False
            out["reason"] = (f"项目标识未能解析（{resolve_warn}），且按现有标识"
                             f"{sorted(ident) if ident else project}一条 run 都没匹配到。"
                             f"无法区分「本周未发布」与「标识没对上」，故报数据不可用；"
                             f"报告本段须写「数据不可用」而非「本周未发布」。")
            out["coverage"]["complete"] = False
            out["coverage"]["warnings"].append(out["reason"])
    return out


# 分支预览部署版本：单独一段，供工程读者参考，禁止当成「线上发布」写进正文
def collect_preview_deploys(project, start, end):
    res = _cdscli(["deployment-version", "list"] + (["--project", project] if project else []))
    if not res.get("ok"):
        return {"available": False, "reason": "cdscli deployment-version list 返回 ok=false"}
    vers = ((res.get("data") or {}).get("versions")) or []
    items = [{"id": v.get("id"), "date": (v.get("createdAt") or "")[:10],
              "commitSha": (v.get("commitSha") or "")[:7], "branchId": v.get("branchId")}
             for v in vers if _in_week(v.get("createdAt") or "", start, end)]
    return {"available": True, "items": items, "count": len(items),
            "note": "不可变部署版本（含分支预览），不等于正式发布次数"}


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
        ("acceptance",     lambda: collect_acceptance(a.project, start, end)),
        ("releases",       lambda: collect_releases(a.project, start, end)),
        ("previewDeploys", lambda: collect_preview_deploys(a.project, start, end)),
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
        if rl.get("available"):
            print(f"[正式发布] 终态 {rl['attempts']} 次：成功 {rl['success']} / 失败 {rl['failed']}"
                  + (f" / 回滚 {rl['rolledBack']}" if rl.get("rolledBack") else "")
                  + (f"，成功率 {rl['successRate']}%" if rl.get("successRate") is not None else "")
                  + (f"；在途 {rl['inFlight']}" if rl.get("inFlight") else ""))
            cov = rl.get("coverage") or {}
            if not cov.get("complete", True):
                for w in cov.get("warnings", []):
                    print("   覆盖不完整：" + w)
            if rl.get("projectResolveWarning"):
                print("   注意：" + rl["projectResolveWarning"])
        else:
            print("[正式发布] 不可用：" + str(rl.get("reason")))
        pv = ctx.get("previewDeploys", {})
        print(f"[分支预览部署] {pv.get('count')} 个不可变版本（非正式发布，勿写进正文）"
              if pv.get("available") else "[分支预览部署] 不可用：" + str(pv.get("reason")))
        if a.out:
            print(f"\n已写入 {a.out}")
    else:
        print(blob)


if __name__ == "__main__":
    main()
