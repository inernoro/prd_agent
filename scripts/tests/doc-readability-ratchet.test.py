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

**一句话**：给守卫测试用的合规样例：导读三行齐、有硬信息、术语都就地解释过。
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

check(any("未就地解释" in p for p in problems_for(
    "guide.demo.md", GOOD_HEADER.replace("给守卫测试用的合规样例：导读三行齐、有硬信息、术语都就地解释过。",
        "说明 buildGate 这道闸在排队时怎么把僵尸请求踢出去的判定。"))),
      "术语没跟中文括号解释被抓出")

check(problems_for("guide.demo.md", GOOD_HEADER.replace("给守卫测试用的合规样例：导读三行齐、有硬信息、术语都就地解释过。",
        "说明 buildGate（同时只放三个构建过闸的那道闸）怎么把僵尸请求踢出队列。")) == [],
      "术语紧跟中文括号解释就放行（术语是信息密度的延伸）")

check(any("空话" in p for p in problems_for(
    "guide.demo.md", GOOD_HEADER.replace("给守卫测试用的合规样例：导读三行齐、有硬信息、术语都就地解释过。",
        "本文介绍了构建队列的相关内容，以及若干注意事项和使用说明。"))),
      "空话套话被抓出")

check(any("密度不够" in p for p in problems_for(
    "guide.demo.md", GOOD_HEADER.replace("给守卫测试用的合规样例：导读三行齐、有硬信息、术语都就地解释过。", "讲构建队列。"))),
      "一句话太短（密度不够）被抓出")

check(any("文件路径" in p for p in problems_for(
    "guide.demo.md", GOOD_HEADER.replace("给守卫测试用的合规样例：导读三行齐、有硬信息、术语都就地解释过。", "说明 cds/src/services/proxy.ts 的行为。"))),
      "「一句话」里的文件路径被抓出")

check(any("代码引用" in p for p in problems_for(
    "guide.demo.md", GOOD_HEADER.replace("给守卫测试用的合规样例：导读三行齐、有硬信息、术语都就地解释过。", "说明 `--ratchet` 参数怎么用。"))),
      "「一句话」里的反引号代码被抓出")

check(any("上限" in p for p in problems_for(
    "guide.demo.md", GOOD_HEADER.replace("给守卫测试用的合规样例：导读三行齐、有硬信息、术语都就地解释过。", "很长的一句话。" * 20))),
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

print("[3] 引用必须可点")

known = {"design.cds.md", "guide.demo.md"}
LINE_BARE = "关联文档：`doc/design.cds.md`。\n"
LINE_LINKED = "关联文档：[doc/design.cds.md](./design.cds.md)。\n"

check(checker.find_bare_refs(LINE_BARE, known) != [], "裸引用（目标真实存在）被抓出")
check(checker.find_bare_refs("反例：`spec.cds-settings.md` 不合规。\n", known) == [],
      "目标不存在的示范文件名不误伤")
check(checker.find_bare_refs("```\n见 `doc/design.cds.md`\n```\n", known) == [],
      "代码块里的路径不误伤")
check(checker.find_bare_refs(LINE_LINKED, known) == [], "已经是链接的不再算欠账")

fixed, n = checker.fix_links(LINE_BARE, known)
check(n == 1 and fixed == LINE_LINKED, "裸引用能被改写成可点链接")
again, n2 = checker.fix_links(fixed, known)
check(n2 == 0 and again == fixed, "改写幂等，不会二次包裹")
nested, n3 = checker.fix_links("见 [`design.cds.md`](./design.cds.md)\n", known)
check(n3 == 0 and "]](" not in nested, "链接文字里的行内代码不会被包成嵌套坏链")

with tempfile.TemporaryDirectory() as tmp:
    p = os.path.join(tmp, "guide.demo.md")
    with open(p, "w", encoding="utf-8") as fh:
        fh.write("见 [不存在的文档](./guide.nope.md) 和 [活的](./guide.demo.md)\n"
                 "以及 [伪协议](wikilink:xxx) 与 [外链](https://example.com)\n")
    dead = checker.find_dead_links(p, open(p, encoding="utf-8").read())
    check(len(dead) == 1 and "guide.nope.md" in dead[0][1], "死链被抓出，伪协议与外链不误报")

print("[3.5] 正文只写人类要掌控的层次")

IMPL_DOC = """# 示例 · 设计

> **版本**：v1.0 | **日期**：2026-07-31 | **状态**：已落地

## 接口设计

```csharp
public interface IFoo { Task BarAsync(string token); }
```

调用方从 prd-api/src/PrdAgent.Api/Services/Foo/FooService.cs 拿到令牌后传入。
"""
impl, srcs = checker.scan_body(IMPL_DOC)
check(impl == 1, f"实现语言代码块被计为欠账（实测 {impl} 行）")
check(srcs == 1, f"正文里散落的源码路径被计为欠账（实测 {srcs} 处）")

ALLOWED_DOC = """# 示例 · 设计

> **版本**：v1.0 | **日期**：2026-07-31 | **状态**：已落地

## 数据流

```mermaid
graph LR; A-->B
```

```json
{"status": "queued"}
```

## 实现来源

- prd-api/src/PrdAgent.Api/Services/Foo/FooService.cs
"""
impl2, srcs2 = checker.scan_body(ALLOWED_DOC)
check(impl2 == 0, "图与契约样例的代码块不算实现代码")
check(srcs2 == 0, "「实现来源」小节里集中列的路径不算欠账")

print("[4] 报告双产物的那句话有人盯着")

SKILLS = os.path.join(REPO_ROOT, ".claude", "skills")
weekly_md = open(os.path.join(SKILLS, "weekly-update-summary", "reference",
                              "report-template.md"), encoding="utf-8").read()
weekly_html = open(os.path.join(SKILLS, "weekly-update-summary", "reference",
                                "report-template-html.html"), encoding="utf-8").read()
daily_html = open(os.path.join(SKILLS, "daily-report-summary", "reference",
                               "report-template-html.html"), encoding="utf-8").read()
check("**本周一句话**" in weekly_md, "周报 md 模板保留「本周一句话」")
check("封面故事" in weekly_html and "<h1>" in weekly_html, "周报 html 模板保留封面故事大标题")
check("今日大事" in daily_html and "TL;DR" in daily_html, "日报 html 模板保留今日大事 TL;DR")

print("[5] 闸门真的接上了")

baseline_path = checker.BASELINE_PATH
check(os.path.exists(baseline_path), "棘轮基线文件存在")

if os.path.exists(baseline_path):
    with open(baseline_path, encoding="utf-8") as fh:
        baseline = json.load(fh)
    missing = baseline.get("missing", {})
    bare_base = baseline.get("bare_refs", {})
    check(set(missing) == set(checker.TYPES), "基线覆盖全部七类文档")
    check(set(bare_base) == set(checker.TYPES), "基线记录了裸引用欠账")

    stats, _ = checker.scan()
    over = [t for t in checker.TYPES if stats[t]["missing"] > missing.get(t, 0)]
    check(not over, f"当前导读欠账未超过基线（超出：{over}）")

    impl_base = baseline.get("impl_code", {})
    src_base = baseline.get("source_refs", {})
    check(set(impl_base) == set(checker.TYPES) and set(src_base) == set(checker.TYPES),
          "基线记录了正文实现代码与源码路径两项欠账")
    impl_now, src_now, _ = checker.scan_bodies()
    check(not [t for t in checker.TYPES if impl_now[t] > impl_base.get(t, 0)],
          "正文实现代码未超过基线")
    check(not [t for t in checker.TYPES if src_now[t] > src_base.get(t, 0)],
          "散落源码路径未超过基线")

    bare_now, _, dead_now = checker.scan_links()
    bare_over = [t for t in checker.TYPES if bare_now[t] > bare_base.get(t, 0)]
    check(not bare_over, f"当前裸引用未超过基线（超出：{bare_over}）")
    check(not dead_now, f"全库无死链（发现 {len(dead_now)} 条）")

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

print("[6] 标准文档自己得合规")

for name in ("rule.doc.readability.md", "guide.doc.reading-map.md", "debt.doc.readability.md"):
    path = os.path.join(REPO_ROOT, "doc", name)
    check(os.path.exists(path) and checker.check_file(path) == [], f"{name} 自身合规")

print()
if failures:
    print(f"FAILED: {len(failures)} 项")
    sys.exit(1)
print("PASSED")
