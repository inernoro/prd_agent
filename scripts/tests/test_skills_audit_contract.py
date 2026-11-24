#!/usr/bin/env python3
"""`--skills-audit` 的输出契约守卫。

为什么需要这条守卫：`entropy-cleanup` 的 D4 完全靠这个模式的**输出前缀**决策——
`AUTOFIX_NAME: ` 触发自动补 name，`BLOCK: ` 触发 Step 4.5 硬闸拦住自动合并。
前缀改一个字、某种坏清单漏判、或者退出码不对，熵减就会静默地要么不修、要么把
不可发现的技能合进去，而全仓测试照样全绿。按 `predicate-and-wiring-discipline.md`：
**改动删掉之后测试仍然全绿，那它就需要一条守卫。**

隔离方式：把被测脚本复制进临时目录，让它的 REPO_ROOT（由脚本自身路径推出）
落在临时仓库上。这样两个技能根都能随意摆布——包括「整个根不存在」这种在真实
仓库里没法安全构造的场景——也不会往真实仓库里写测试垃圾。
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TARGET = os.path.join(REPO_ROOT, "scripts", "doc-readability-check.py")

GOOD_FM = (
    "---\n"
    "name: {name}\n"
    "description: 演示技能。当用户说「跑演示」「demo」时触发，用于验证审计判据的输出契约。\n"
    "---\n\n# {name}\n"
)

failures: list[str] = []


def check(label: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label}{(' — ' + detail) if detail else ''}")
        failures.append(label)


def make_repo(tmp: str) -> str:
    """搭一个最小临时仓库：scripts/ 放被测脚本副本，两个技能根各放一个合法技能。"""
    os.makedirs(os.path.join(tmp, "scripts"))
    shutil.copy(TARGET, os.path.join(tmp, "scripts", "doc-readability-check.py"))
    for root in (".claude/skills", ".agents/skills"):
        d = os.path.join(tmp, root, "ok-skill" if root.startswith(".claude") else "ok-skill-b")
        os.makedirs(d)
        name = os.path.basename(d)
        with open(os.path.join(d, "SKILL.md"), "w", encoding="utf-8") as fh:
            fh.write(GOOD_FM.format(name=name))
    return tmp


def run(tmp: str, *extra: str) -> tuple[int, str]:
    proc = subprocess.run(
        [sys.executable, *extra, os.path.join(tmp, "scripts", "doc-readability-check.py"), "--skills-audit"],
        capture_output=True, text=True,
    )
    return proc.returncode, proc.stdout + proc.stderr


def case(label: str, build, expect_rc: int, expect_sub: str | None, forbid_sub: str | None = None) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        make_repo(tmp)
        build(tmp)
        rc, out = run(tmp)
        ok = rc == expect_rc
        if expect_sub is not None:
            ok = ok and expect_sub in out
        if forbid_sub is not None:
            ok = ok and forbid_sub not in out
        check(label, ok, f"rc={rc} out={out.strip()[:160]!r}")


def write(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


print("== --skills-audit 输出契约 ==")

# 1. 干净：两个根都在、技能都合法 → 退出 0，不产出任何判定行
case("干净的仓库退出 0 且无 BLOCK/AUTOFIX", lambda t: None, 0, None, forbid_sub="BLOCK:")

# 2. 可自动修：扁平 frontmatter 缺 name → AUTOFIX_NAME，前缀逐字固定
case(
    "缺 name（扁平 frontmatter）判为 AUTOFIX_NAME",
    lambda t: write(
        os.path.join(t, ".claude/skills/needs-name/SKILL.md"),
        "---\ndescription: 演示技能。当用户说「跑演示」时触发，用于验证缺 name 的自动修复分类。\n---\n",
    ),
    1, "AUTOFIX_NAME: .claude/skills/needs-name",
)

# 3. 缺 name 但结构看不懂 → 必须 BLOCK，绝不能判为可自动修。
#    这是最关键的一条：自动补上 name 会让下一轮审计判绿，把坏清单洗成假绿灯。
case(
    "缺 name + 嵌套结构 → BLOCK 而非 AUTOFIX（防洗白假绿灯）",
    lambda t: write(
        os.path.join(t, ".claude/skills/nested-bad/SKILL.md"),
        "---\ndescription: 演示技能。当用户说「跑演示」时触发，用于验证嵌套结构的判定。\n"
        "metadata:\n  tags: [unclosed\n---\n",
    ),
    1, "BLOCK: .claude/skills/nested-bad", forbid_sub="AUTOFIX_NAME:",
)

# 4. 目录里整个没有 SKILL.md（scan_skills 的既有盲区）
case(
    "技能目录没有 SKILL.md → BLOCK",
    lambda t: os.makedirs(os.path.join(t, ".claude/skills/empty-dir")),
    1, "BLOCK: .claude/skills/empty-dir",
)

# 5. 声明的技能根整个不存在 → 那个宿主的技能全部不可发现，必须 BLOCK
case(
    "技能根整个消失 → BLOCK",
    lambda t: shutil.rmtree(os.path.join(t, ".agents/skills")),
    1, "BLOCK: .agents/skills",
)


# 6. 读不了 / 解不了码的清单：必须转成 BLOCK 而不是抛异常。
#    抛异常会让调用方在拿到任何 BLOCK 行之前断流，下游 `| grep '^BLOCK: ' || true`
#    的写法就会把崩溃读成「干净」，闸门 fail-open。
def _undecodable(t: str) -> None:
    d = os.path.join(t, ".claude/skills/bad-bytes")
    os.makedirs(d)
    with open(os.path.join(d, "SKILL.md"), "wb") as fh:
        fh.write(b"---\nname: bad-bytes\n\xff\xfe\n---\n")


case("非 UTF-8 清单 → BLOCK 而非抛异常", _undecodable, 1, "BLOCK: .claude/skills/bad-bytes")

# 7. 判据不能随环境变。曾经引入 PyYAML，结果没装它的环境里合法技能全被判 BLOCK、
#    熵减自动合并被永久关死。这条钉住「有没有第三方库，结论一致」。
print("== 判据不依赖第三方库（-S 无 site-packages） ==")
with tempfile.TemporaryDirectory() as tmp:
    make_repo(tmp)
    write(
        os.path.join(tmp, ".claude/skills/nested-bad/SKILL.md"),
        "---\ndescription: 演示技能。当用户说「跑演示」时触发，用于验证嵌套结构的判定。\n"
        "metadata:\n  tags: [unclosed\n---\n",
    )
    rc_plain, out_plain = run(tmp)
    rc_bare, out_bare = run(tmp, "-S")
    check("-S 与普通环境的退出码一致", rc_plain == rc_bare, f"{rc_plain} vs {rc_bare}")
    check("-S 与普通环境的输出逐字一致", out_plain == out_bare,
          f"plain={out_plain.strip()[:120]!r} bare={out_bare.strip()[:120]!r}")

# 8. 前缀本身就是契约：entropy-cleanup 靠 grep '^AUTOFIX_NAME: ' / '^BLOCK: ' 决策，
#    所以判定行必须顶格，不能被缩进或加前缀装饰。
print("== 判定行顶格（下游靠 ^ 锚点 grep） ==")
with tempfile.TemporaryDirectory() as tmp:
    make_repo(tmp)
    os.makedirs(os.path.join(tmp, ".claude/skills/empty-dir"))
    write(
        os.path.join(tmp, ".claude/skills/needs-name/SKILL.md"),
        "---\ndescription: 演示技能。当用户说「跑演示」时触发，用于验证缺 name 的自动修复分类。\n---\n",
    )
    _, out = run(tmp)
    verdict_lines = [ln for ln in out.splitlines() if "BLOCK:" in ln or "AUTOFIX_NAME:" in ln]
    check("产出了判定行", len(verdict_lines) >= 2, repr(out[:200]))
    check("每条判定行都以契约前缀顶格开头",
          all(ln.startswith(("BLOCK: ", "AUTOFIX_NAME: ")) for ln in verdict_lines),
          repr(verdict_lines))

print()
if failures:
    print(f"[FAIL] {len(failures)} 项不通过：" + "，".join(failures))
    sys.exit(1)
print("[OK] --skills-audit 输出契约守卫全部通过")
