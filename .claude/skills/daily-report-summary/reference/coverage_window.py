#!/usr/bin/env python3
"""日报采集窗口解析（水位线 / watermark）。

回答一个问题：**这次日报该从哪里开始采？**

答案永远是「上一期日报采到哪，这期就从哪续」——不是「今天 00:00」。
两者的差别就是 2026-07-30 暴露的那个洞：日报每天早上 09:10 跑，按**日历日**
过滤提交，于是当天 09:10 之后落地的提交，既不在当天的报告里（已经跑完了），
也不在第二天的报告里（日期桶不对），永久漏报。实测 07-28/07-29 两天漏掉
8 个主干条目 / 36 个真实提交，含 4 个 feat。

水位线以**提交 SHA** 为准（而不是日期或时间戳）：
  - 天然免疫时区问题（git 的 %cd 用提交自带时区，容器用 UTC，两者会错位一天）
  - 天然处理中断续上：漏跑三天，下次窗口自动横跨三天，不需要额外补偿逻辑
  - 天然免疫「同一秒多个提交」的边界重叠

三级兜底（前一级不可用才降级，每级都会在输出里标明 mode）：
  1. sha      —— 上期 metadata.lastCommit 在本地 git 里存在 → 窗口 = (lastCommit, HEAD]
  2. since    —— SHA 不存在（force push / 浅克隆截断）→ 用 metadata.coverTo 时间戳
  3. today    —— 两者都没有（首次运行 / 库是空的）→ 退化为当日，与旧行为一致

用法：
  export AI_ACCESS_KEY=...          # 或 DAILY_DOC_STORE_KEY（document-store:read 即可）
  python3 coverage_window.py --base https://main-prd-agent.miduo.org --impersonate inernoro
  # 输出 JSON 到 stdout；诊断信息一律走 stderr，保证 stdout 是单份可解析 JSON

输出字段：
  mode        sha | since | today
  baseSha     窗口起点提交（不含）；mode=sha 时有值
  sinceIso    窗口起点时间戳（不含）；mode=since 时有值
  headSha     窗口终点提交（含）——就是本次要写进 metadata.lastCommit 的值
  revRange    可直接喂给 git log 的区间串，如 "b239edcff..HEAD"
  spanDays    窗口横跨的自然日数（用于判断是否「补记期」）
  prevDate    上一期日报的 dailyDate
  gap         True 表示上期水位线之后有超过一天没报道（中断续上场景）
"""
import argparse, json, os, subprocess, sys, time
from datetime import datetime, timezone

API = "/api/document-store"
STORE_NAME = "日报知识库"


def log(msg):
    """诊断信息走 stderr —— stdout 必须是干净的单份 JSON，否则调用方 json.loads 会炸。"""
    sys.stderr.write(msg + "\n")


def curl(args, retries=4):
    last = ""
    for i in range(retries):
        r = subprocess.run(["curl", "-s", "--max-time", "120"] + args, capture_output=True, text=True)
        last = r.stdout
        try:
            return json.loads(r.stdout)
        except Exception:
            if i < retries - 1:
                time.sleep(3 * (i + 1)); continue
    raise RuntimeError("curl 返回非 JSON（多为预览环境 524/重启）：" + (last or "")[:160])


def headers(impersonate):
    key = os.environ.get("DAILY_DOC_STORE_KEY", "").strip() or os.environ.get("MAP_DOC_STORE_KEY", "").strip()
    if key:
        return ["-H", f"Authorization: Bearer {key}"]
    super_key = os.environ.get("AI_ACCESS_KEY", "").strip()
    if not super_key:
        raise RuntimeError("既无 DAILY_DOC_STORE_KEY 也无 AI_ACCESS_KEY，无法读知识库水位线")
    return ["-H", f"X-AI-Access-Key: {super_key}", "-H", f"X-AI-Impersonate: {impersonate}"]


def find_store(base, H, name):
    page = 1
    while True:
        res = curl(H + [f"{base}/stores?page={page}&pageSize=100"])
        if not res.get("success"):
            raise RuntimeError("列出知识库失败，无法读取水位线（拒绝当成首次运行以免重复报道）")
        data = res.get("data") or {}
        for s in (data.get("items") or []):
            if s.get("name") == name:
                return s
        items = data.get("items") or []
        if data.get("hasNextPage") is False or len(items) < 100:
            return None
        page += 1
        if page > 1000:
            raise RuntimeError("知识库分页异常")


def latest_daily_entry(base, H, store_id, kind, before_date=""):
    """取 dailyDate 最大的一篇日报条目。

    before_date 非空时只看**严格早于**它的条目——补历史或重跑当天时，
    不能把「今天已经发过的那篇」当成自己的水位线（否则窗口塌成空集）。
    """
    best, page = None, 1
    while True:
        # all=true 必须带：后端 ListEntries 默认 all=false，只返回**根级**条目
        # （按 ParentId 过滤）。一旦有人把日报整理进文件夹，水位线就会看不见它，
        # 退回更旧的水位线或 today 模式，重新制造漏报/重复覆盖。
        res = curl(H + [f"{base}/stores/{store_id}/entries?page={page}&pageSize=100&all=true"])
        if not res.get("success"):
            raise RuntimeError("列出条目失败，无法读取水位线")
        data = res.get("data") or {}
        items = data.get("items") or []
        for it in items:
            md = it.get("metadata") or {}
            # 只认正牌日报条目：库里可能混入手工「新建文档」等无 metadata 的条目
            if (md.get("kind") or "") != kind:
                continue
            d = (md.get("dailyDate") or "").strip()
            if not d:
                continue
            if before_date and d >= before_date:
                continue
            # 同 dailyDate 可能有多条（历史竞态留下的重复）。后端按 CreatedAt 倒序返回，
            # 若只用 `d > best` 取先遇到的，选中的会是**最新建**的那条——它未必是本期
            # 真正更新过的那条，可能带着过期甚至缺失的水位线。
            # 判据改为：先比 dailyDate，同日则**优先带 lastCommit 的**，仍并列再比 coverTo。
            # 这样即便库里有重复，也总能选到信息最完整的那条。
            cand = (d, 1 if (md.get("lastCommit") or "").strip() else 0, (md.get("coverTo") or ""))
            if best is None or cand > best[0]:
                best = (cand, md, it.get("id"))
        if data.get("hasNextPage") is False or len(items) < 100:
            break
        page += 1
        if page > 1000:
            break
    return best


def git(*args):
    r = subprocess.run(["git"] + list(args), capture_output=True, text=True)
    return r.returncode, r.stdout.strip(), r.stderr.strip()


def sha_usable(sha, head):
    """水位线可用 = 对象在本地存在 **且** 是 head 的祖先。

    只查 cat-file 不够：main 被 force push 后，旧水位线对象往往**仍留在本地**
    （reflog、上一次 fetch 的悬挂对象），cat-file 会成功，但它已经不在 head 的
    历史里了。此时 `old..head` 的语义是「head 可达而 old 不可达的全部提交」——
    等于把整段新历史算进本期窗口，可能把大半个 main 重新报道一遍。
    祖先校验不通过时应当降级到 coverTo 时间戳，而不是硬用这个 SHA。
    """
    if not sha or not head:
        return False
    # ^{commit} 确保它真是个 commit 对象且在本地可达（浅克隆截断后会失败）
    code, _, _ = git("cat-file", "-e", f"{sha}^{{commit}}")
    if code != 0:
        return False
    code, _, _ = git("merge-base", "--is-ancestor", sha, head)
    return code == 0


def head_for_target(branch, target_date):
    """把窗口右端收敛到 target_date 当天（含）的最后一个主干提交。

    补历史 / 重跑过去某天时，右端**不能**用当前分支 tip：否则窗口会变成
    「上期水位线 → 现在」，把目标日之后的提交publish 到目标日那篇报告里，
    并且配合 --replace-same-date 会覆盖掉原本正确的那篇。

    按 `%cd --date=short` 的日期文本比较，与技能其余部分同口径（不做时区换算）。
    git log 是倒序，第一个 <= target_date 的即当天最后一个主干提交。
    """
    if not target_date:
        return ""
    code, out, _ = git("log", "--first-parent", branch, "--format=%cd%x09%H", "--date=short")
    if code != 0:
        return ""
    for line in out.splitlines():
        d, _, sha = line.partition("\t")
        if d <= target_date:
            return sha
    return ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--impersonate", default="inernoro")
    ap.add_argument("--store", default=STORE_NAME)
    ap.add_argument("--kind", default="daily-report")
    ap.add_argument("--branch", default="", help="主干 ref，缺省自动解析 origin/HEAD → origin/main")
    ap.add_argument("--target-date", default="", help="本期目标日期 YYYY-MM-DD；补历史/重跑当天时用它排除自己那篇")
    a = ap.parse_args()

    branch = a.branch
    if not branch:
        code, out, _ = git("symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD")
        branch = out if code == 0 and out else "origin/main"

    code, head, _ = git("rev-parse", branch)
    if code != 0:
        raise RuntimeError(f"解析主干 {branch} 失败——请先 git fetch origin")

    # 窗口右端按目标日收敛（补历史/重跑必需；当期运行时通常就等于 tip）。
    bounded = head_for_target(branch, a.target_date)
    if a.target_date and not bounded:
        # 收敛不出右端（多为浅克隆没拉到那么早，--unshallow 又是 best-effort 失败了）时
        # **必须中止**，不能"退回 tip 继续"：那等于把窗口右端悄悄放大到现在，
        # 补历史会把目标日之后的提交写进目标日那篇，再叠加 --replace-same-date
        # 覆盖掉原本正确的报告——正是本 PR 要根治的那类静默退化。
        log(f"[水位线][错误] 无法把窗口右端收敛到 target-date={a.target_date}："
            f"{branch} 上没有日期 <= 该日的主干提交（浅克隆未拉全？先跑 git fetch --unshallow）。"
            " 拒绝退回当前 tip，以免把目标日之后的提交写进该日报告。")
        sys.exit(3)
    if bounded and bounded != head:
        log(f"[水位线] 窗口右端按 target-date={a.target_date} 收敛到 {bounded[:12]}（tip 为 {head[:12]}）")
        head = bounded

    out = {"mode": "today", "baseSha": "", "sinceIso": "", "excludeSha": "", "headSha": head,
           "branch": branch, "revRange": "", "spanDays": 1, "prevDate": "", "gap": False}

    try:
        base = a.base.rstrip("/") + API
        H = headers(a.impersonate)
        store = find_store(base, H, a.store)
        if not store:
            log(f"[水位线] 知识库「{a.store}」不存在 → 首次运行，退化为当日口径")
            print(json.dumps(out, ensure_ascii=False)); return
        prev = latest_daily_entry(base, H, store["id"], a.kind, before_date=a.target_date)
        if not prev:
            log("[水位线] 库中无历史日报条目 → 首次运行，退化为当日口径")
            print(json.dumps(out, ensure_ascii=False)); return
        prev_key, md, _eid = prev
        prev_date = prev_key[0]
        out["prevDate"] = prev_date
        last_sha = (md.get("lastCommit") or "").strip()
        cover_to = (md.get("coverTo") or "").strip()
        log(f"[水位线] 上一期：dailyDate={prev_date} lastCommit={last_sha[:12] or '(无)'} coverTo={cover_to or '(无)'}")

        if sha_usable(last_sha, head):
            out["mode"] = "sha"; out["baseSha"] = last_sha
            out["revRange"] = f"{last_sha}..{head}"
        elif cover_to:
            # 上期没记 SHA（老版本条目）、SHA 已不可达、或 SHA 不是本次 head 的祖先
            # （force push 后旧对象残留 / 补历史时右端早于水位线）→ 退到时间戳
            out["mode"] = "since"; out["sinceIso"] = cover_to
            out["revRange"] = head
            # git 的 --since 是**闭区间**（实测 git 2.43：把某提交的 %cI 喂回 --since，
            # 该提交自身会被返回）。而 coverTo 恰好是上期最后一个提交的 %cI，
            # 于是 since 模式的窗口变成左闭 —— 上期最后那个提交会被重复统计一次；
            # 它若是 merge，Phase 2 还会穿透它、把上一个 PR 的所有提交再算一遍，
            # 报告数字直接虚高。这里把它的 SHA 透出去，由调用方按 SHA 精确剔除，
            # 从而还原「左开右闭」语义（不用 +1 秒，避免误伤同一秒内的新提交）。
            out["excludeSha"] = last_sha
            if not last_sha:
                log("[水位线][告警] since 模式但上期未记 lastCommit，无法按 SHA 剔除边界提交，"
                    "窗口左端为闭区间——上期最后一个提交可能被重复统计一次")
            if last_sha:
                log(f"[水位线] lastCommit {last_sha[:12]} 不可用（不可达，或非 {head[:12]} 的祖先）"
                    " → 降级用 coverTo 时间戳")
            else:
                log("[水位线] 上期未记 lastCommit（旧版条目）→ 降级用 coverTo 时间戳")
        else:
            # 老条目既无 SHA 也无 coverTo：只能退回当日口径，并明确告警——
            # 这正是本次要根治的旧行为，必须让调用方看见它还在生效。
            log(f"[水位线] 上期（{prev_date}）无 lastCommit 也无 coverTo（本次改造之前发布的条目）"
                " → 本期仍按当日口径；下期起水位线即可生效")
            print(json.dumps(out, ensure_ascii=False)); return

        # 算窗口横跨天数 + 是否属于「中断续上」
        if out["mode"] == "sha":
            _c, base_date, _e = git("log", "-1", out["baseSha"], "--format=%cd", "--date=short")
        else:
            base_date = out["sinceIso"][:10]
        _c, head_date, _e = git("log", "-1", head, "--format=%cd", "--date=short")
        try:
            d0 = datetime.strptime(base_date, "%Y-%m-%d")
            d1 = datetime.strptime(head_date, "%Y-%m-%d")
            out["spanDays"] = max(1, (d1 - d0).days + 1)
            # 上期日报日期与本期 HEAD 日期差超过 1 天 = 中间有天没出报告（或有天被漏采）
            dp = datetime.strptime(prev_date, "%Y-%m-%d")
            out["gap"] = (d1 - dp).days > 1
        except Exception:
            pass
        log(f"[水位线] 窗口 mode={out['mode']} range={out['revRange'][:24]} "
            f"跨 {out['spanDays']} 天 gap={out['gap']}")
    except Exception as e:
        # 读不到水位线绝不能静默当成「首次运行」重报一遍历史——明确失败让人来看
        log(f"[水位线][错误] {e}")
        sys.exit(3)

    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
