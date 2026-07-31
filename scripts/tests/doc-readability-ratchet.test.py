#!/usr/bin/env python3
"""doc-readability-check.py 的守卫测试。

守两件事：
1. 校验器本身没坏 —— 缺导读、写成黑话、长度超限都必须被抓出来；
   反过来，合规文档不许被误报。
2. 这条闸真的接上了 —— 基线文件在、七类都在、CI 里有人跑它。
   （`.claude/rules/predicate-and-wiring-discipline.md` 形状 2：
    建了一半的链路删掉不会红。）
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CHECKER = os.path.join(REPO_ROOT, "scripts", "doc-readability-check.py")

spec = importlib.util.spec_from_file_location("doc_readability_check", CHECKER)
assert spec and spec.loader
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)

failures: list[str] = []


def check(condition: bool, message: str) -> None:
    if condition:
        print(f"  ok   {message}")
    else:
        print(f"  FAIL {message}")
        failures.append(message)


def problems_for(filename: str, body: str) -> list[str]:
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, filename)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(body)
        return checker.check_file(path)


GOOD_HEADER = """# 示例 · 指南

> **版本**：v1.0 | **日期**：2026-07-31 | **状态**：已落地

**一句话**：讲清楚这份示例文档解决什么问题。
**谁该读**：写测试的人，以及想看合规样例的人。
**读完能做什么**：照着写出一份合规的导读三行。

## 正文
"""

print("[1] 校验器能抓出问题")

check(problems_for("guide.demo.md", GOOD_HEADER) == [],
      "合规文档不被误报")

check(any("缺「谁该读」" in p for p in problems_for(
    "guide.demo.md", GOOD_HEADER.replace("**谁该读**：写测试的人，以及想看合规样例的人。\n", ""))),
      "缺「谁该读」被抓出")

check(any("缺「一句话」" in p for p in problems_for("guide.demo.md", "# 无导读 · 指南\n\n正文\n")),
      "整篇没有导读被抓出")

check(any("驼峰" in p for p in problems_for(
    "guide.demo.md", GOOD_HEADER.replace("讲清楚这份示例文档解决什么问题。", "说明 buildGate 的行为。"))),
      "「一句话」里的驼峰标识符被抓出")

check(any("文件路径" in p for p in problems_for(
    "guide.demo.md", GOOD_HEADER.replace("讲清楚这份示例文档解决什么问题。", "说明 cds/src/services/proxy.ts 的行为。"))),
      "「一句话」里的文件路径被抓出")

check(any("代码引用" in p for p in problems_for(
    "guide.demo.md", GOOD_HEADER.replace("讲清楚这份示例文档解决什么问题。", "说明 `--ratchet` 参数怎么用。"))),
      "「一句话」里的反引号代码被抓出")

check(any("上限" in p for p in problems_for(
    "guide.demo.md", GOOD_HEADER.replace("讲清楚这份示例文档解决什么问题。", "很长的一句话。" * 20))),
      "「一句话」超长被抓出")

check(any("等于没写" in p for p in problems_for(
    "guide.demo.md", GOOD_HEADER.replace("写测试的人，以及想看合规样例的人。", "所有人"))),
      "「谁该读」写「所有人」被抓出")

FENCED_ONLY = """# 模板示例 · 规则

> **版本**：v1.0 | **日期**：2026-07-31 | **状态**：已落地

```markdown
**一句话**：这只是展示给作者看的格式示例。
**谁该读**：想知道导读三行长什么样的人。
**读完能做什么**：照着写。
```

## 正文
"""
check(any("缺「一句话」" in p for p in problems_for("rule.demo.md", FENCED_ONLY)),
      "只在代码块里展示格式不算合规（模板文档不能自己骗过闸门）")

print("[2] 周报走定期刊物口径")

WEEKLY = """# 周报 2026-W99 (2026-07-20 ~ 2026-07-26)

> **本周一句话**：这周把模型网关的发布通道打通了，验收通过率从六成升到九成。

## 一、质量闸
"""
check(problems_for("report.2026-W99.md", WEEKLY) == [],
      "周报只写「本周一句话」即合规（读者固定，不强加样板）")
check(any("缺「一句话」" in p for p in problems_for(
    "report.2026-W99.md", "# 周报 2026-W99\n\n## 一、质量闸\n")),
      "周报连一句话都没有仍被抓出")

print("[3] 闸门真的接上了")

baseline_path = checker.BASELINE_PATH
check(os.path.exists(baseline_path), "棘轮基线文件存在")

if os.path.exists(baseline_path):
    with open(baseline_path, encoding="utf-8") as fh:
        baseline = json.load(fh)
    missing = baseline.get("missing", {})
    check(set(missing) == set(checker.TYPES), "基线覆盖全部七类文档")

    stats, _ = checker.scan()
    over = [t for t in checker.TYPES if stats[t]["missing"] > missing.get(t, 0)]
    check(not over, f"当前欠账未超过基线（超出：{over}）")

ci_path = os.path.join(REPO_ROOT, ".github", "workflows", "ci.yml")
with open(ci_path, encoding="utf-8") as fh:
    ci = fh.read()
check("scripts/tests/doc-readability-ratchet.test.py" in ci, "CI 里跑了本测试")
check("doc-readability-check.py --ratchet" in ci, "CI 里跑了棘轮闸门")
# 下面三条守的是「接了一半」：filter 写了但 output 没导出、job 建了但没人依赖，
# 都会让这道闸在 PR 上静默不跑（predicate-and-wiring-discipline 形状 2）。
check("docs: ${{ steps.filter.outputs.docs }}" in ci, "changes job 导出了 docs 变更信号")
check("needs.changes.outputs.docs" in ci, "docs-readability job 消费了该信号")
check("cds-build, docs-readability]" in ci, "docs-readability 已并入 CI Status 汇总闸")

print("[4] 标准文档自己得合规")

for name in ("rule.doc.readability.md", "guide.doc.reading-map.md", "debt.doc.readability.md"):
    path = os.path.join(REPO_ROOT, "doc", name)
    check(os.path.exists(path) and checker.check_file(path) == [], f"{name} 自身合规")

print()
if failures:
    print(f"FAILED: {len(failures)} 项")
    sys.exit(1)
print("PASSED")
