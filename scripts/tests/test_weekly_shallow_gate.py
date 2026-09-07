#!/usr/bin/env python3
"""周报浅克隆闸的行为守卫。

守什么：`collect_week_context.py --check-shallow-only` 的退出码语义，以及
SKILL.md Phase 2.0 那段 shell 接线。两者任何一半退化，本文件必须变红。

为什么需要它：这道闸在 PR #1507 的评审里被连续找出六次 fail-open（判错 /
装晚 / 「没查成」当没问题 / 「没跑起来」当通过 / 补救失败仍放行 / 包装层
吃掉逃生阀），每一次都是靠人工在会话里跑一遍发现的，跑完就没了。按
`.claude/rules/predicate-and-wiring-discipline.md`：改动删掉之后测试仍然
全绿，就需要一条守卫。删掉 assert_not_shallow() 或删掉 case 的 *) 分支，
在本文件之前是全绿的。

被测对象刻意包含 **SKILL.md 里那段 shell**，而不只是 Python 函数：这道闸
的一半逻辑活在文档的代码块里，只测 Python 等于只测了一半（形状 2）。

自证有牙（末尾 mutation 段）：把修复临时改回事故写法，断言守卫真的变红。
不做这一步的话，本文件可能只是一组恰好通过的断言。
"""

import os
import re
import shutil
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
COLLECTOR = os.path.join(
    REPO, ".claude", "skills", "weekly-update-summary", "scripts", "collect_week_context.py"
)
SKILL = os.path.join(REPO, ".claude", "skills", "weekly-update-summary", "SKILL.md")

FAILURES = []


def check(name, got, want):
    if got == want:
        print(f"  [ok] {name}: {got}")
    else:
        print(f"  [FAIL] {name}: 实得 {got}，期望 {want}")
        FAILURES.append(name)


def git(*args, cwd=None, check_rc=True):
    r = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    if check_rc and r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} 失败：{r.stderr.strip()}")
    return r


def make_repo(path):
    """造一个有真实历史的仓库，而不是依赖 CI 的 checkout。

    actions/checkout 默认就是深度 1 的浅克隆，拿它当「正常仓库」这一格
    会让本守卫在 CI 上恒红——被测环境本身就是被测的那个坏状态。
    """
    os.makedirs(path, exist_ok=True)
    git("init", "-q", "-b", "main", cwd=path)
    git("config", "user.email", "guard@example.invalid", cwd=path)
    git("config", "user.name", "guard", cwd=path)
    for i in range(3):
        with open(os.path.join(path, f"f{i}.txt"), "w") as f:
            f.write(str(i))
        git("add", "-A", cwd=path)
        git("commit", "-q", "-m", f"c{i}", cwd=path)
    return path


def make_shallow(src, dst):
    git("clone", "--depth", "1", "-q", f"file://{src}", dst)
    out = git("rev-parse", "--is-shallow-repository", cwd=dst).stdout.strip()
    assert out == "true", f"夹具没造出浅克隆（rev-parse 返回 {out!r}），后续几格测的就不是浅克隆了"
    return dst


def gate(cwd, *extra, env=None):
    e = dict(os.environ)
    if env:
        e.update(env)
    return subprocess.run(
        [sys.executable, COLLECTOR, "--check-shallow-only", *extra],
        cwd=cwd, capture_output=True, text=True, env=e,
    ).returncode


def fake_git(dirpath, fetch_rc, fetch_msg="remote: fake"):
    """造一个 git 影子：只改 fetch 的行为，其余转发真 git。"""
    os.makedirs(dirpath, exist_ok=True)
    p = os.path.join(dirpath, "git")
    real = shutil.which("git")
    with open(p, "w") as f:
        f.write(
            "#!/bin/sh\n"
            'if [ "$1" = "fetch" ]; then echo "%s" >&2; exit %d; fi\n'
            'exec %s "$@"\n' % (fetch_msg, fetch_rc, real)
        )
    os.chmod(p, 0o755)
    return dirpath


def extract_snippet():
    """取 SKILL.md 里含 gate() 的那个 bash 代码块。

    不用 sed 到第一个 fi 之类的边界猜测——那样会截出半截脚本，把没有拒绝
    逻辑的残片当成完整的测（这个错误在 PR #1507 的评审过程中真的发生过）。
    """
    src = open(SKILL, encoding="utf-8").read()
    blocks = [b for b in re.findall(r"```bash\n(.*?)```", src, re.S) if "gate()" in b]
    if len(blocks) != 1:
        raise AssertionError(f"SKILL.md 里含 gate() 的 bash 代码块应恰好 1 个，实得 {len(blocks)}")
    snippet = blocks[0]
    abs_path = os.path.join(REPO, ".claude", "skills")
    if ".claude/skills" not in snippet:
        raise AssertionError("代码块里没有采集器路径，替换会静默失效，测的就不是它了")
    return snippet.replace(".claude/skills", abs_path)


def run_snippet(snippet, cwd, extra_path=None, python_shim=None):
    e = dict(os.environ)
    parts = [p for p in (extra_path, python_shim) if p]
    if parts:
        e["PATH"] = os.pathsep.join(parts + [e["PATH"]])
    with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False) as f:
        f.write(snippet)
        script = f.name
    try:
        return subprocess.run(["bash", script], cwd=cwd, capture_output=True, text=True, env=e).returncode
    finally:
        os.unlink(script)


def main():
    tmp = tempfile.mkdtemp(prefix="shallow-gate-guard-")
    try:
        origin = make_repo(os.path.join(tmp, "origin"))
        deep = make_repo(os.path.join(tmp, "deep"))
        nogit = os.path.join(tmp, "nogit")
        os.makedirs(nogit)

        print("[1/3] 采集器退出码语义（0 放行 / 2 浅克隆 / 3 没查成）")
        check("正常仓库", gate(deep), 0)
        check("浅克隆", gate(make_shallow(origin, os.path.join(tmp, "s1"))), 2)
        check("浅克隆 + --allow-shallow", gate(make_shallow(origin, os.path.join(tmp, "s2")), "--allow-shallow"), 0)
        # 探测失败必须是 3，不能是 0：git 失败时 stdout 为空，直接比字符串会把
        # 「没查成」判成「不是浅克隆」，发出假的合格证明。
        check("非 git 目录（探测失败）", gate(nogit), 3)
        check("非 git 目录 + --allow-shallow", gate(nogit, "--allow-shallow"), 0)

        print("[2/3] SKILL.md Phase 2.0 的 shell 接线（放行只有 0，其余一律拒绝）")
        snip = extract_snippet()
        fail_fetch = fake_git(os.path.join(tmp, "bin-fail"), 128, "fatal: could not read Username")
        noop_fetch = fake_git(os.path.join(tmp, "bin-noop"), 0)
        crash_py = os.path.join(tmp, "bin-py")
        os.makedirs(crash_py, exist_ok=True)
        with open(os.path.join(crash_py, "python3"), "w") as f:
            f.write("#!/bin/sh\nexit 137\n")
        os.chmod(os.path.join(crash_py, "python3"), 0o755)

        check("接线-正常仓库放行", run_snippet(snip, deep), 0)
        check("接线-探测失败拒绝", run_snippet(snip, nogit), 1)
        check("接线-浅克隆且 unshallow 真成功则放行",
              run_snippet(snip, make_shallow(origin, os.path.join(tmp, "s3"))), 0)
        check("接线-unshallow 失败则拒绝",
              run_snippet(snip, make_shallow(origin, os.path.join(tmp, "s4")), extra_path=fail_fetch), 1)
        # 补救「报成功」但仓库仍浅：不重验就会放行，这是最隐蔽的一种。
        check("接线-unshallow 假成功仍浅则拒绝",
              run_snippet(snip, make_shallow(origin, os.path.join(tmp, "s5")), extra_path=noop_fetch), 1)
        check("接线-闸自己崩了也拒绝",
              run_snippet(snip, deep, python_shim=crash_py), 1)

        print("[3/3] mutation：把修复改回事故写法，守卫必须变红")
        # 3a 删掉 *) 分支 → 闸崩掉时应重新变成静默放行
        no_wildcard = re.sub(r"^else\n.*?\n  exit 1\nfi\n?", "fi\n", snip, flags=re.S | re.M)
        if no_wildcard == snip:
            no_wildcard = snip.replace('if [ "$rc" -eq 0 ]; then', 'if [ "$rc" -ne 999 ]; then')
        check("mutation-去掉默认拒绝后闸崩了会放行",
              run_snippet(no_wildcard, deep, python_shim=crash_py), 0)
        # 3b 删掉「补完重验」那一行 → 补救成功的合法路径会被误拒。
        #
        # 注意方向：在当前这个 if 结构里，rc 在补救分支之后仍是 2，最后那道
        # 默认拒绝会兜住它，所以删掉重验**不会**变成 fail-open，而是变成误拒
        # （unshallow 真成功了也不放行）。历史上那次真正的 fail-open 出在 case
        # 写法里——arm 2 的退出状态直接决定整段结果。断言必须照实写成误拒，
        # 不能为了叙事顺口写成放行：那样这一格会恒红，或者更糟，被人改成
        # 恒绿的空断言。
        no_recheck = re.sub(r"\n *gate; rc=\$\?.*?\n", "\n", snip, count=1)
        if no_recheck == snip:
            raise AssertionError("mutation 3b 没改到东西——它证明不了任何事，等于一条空跑的绿灯")
        check("mutation-去掉补后重验则补救成功也会被误拒",
              run_snippet(no_recheck, make_shallow(origin, os.path.join(tmp, "s6"))), 1)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print()
    if FAILURES:
        print(f"FAILED: {len(FAILURES)} 项不符：{', '.join(FAILURES)}")
        sys.exit(1)
    print("OK 周报浅克隆闸守卫全部通过")


if __name__ == "__main__":
    main()
