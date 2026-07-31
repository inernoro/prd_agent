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
import subprocess
import pathlib
import re
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

BEFORE_H1 = ("**一句话**：导读跑到标题上面去了，读者打开先看到的是标题不是它。\n"
             "**谁该读**：把导读写在标题之前的人。\n"
             "**读完能做什么**：知道导读必须在 H1 之后。\n\n# 示例 · 指南\n")
check(any("缺「一句话」" in p for p in problems_for("guide.demo.md", BEFORE_H1)),
      "导读写在 H1 之前不算数（写在标题前读者看不见）")
check(any("缺「一句话」" in p for p in problems_for(
    "guide.demo.md", GOOD_HEADER.replace("# 示例 · 指南\n", ""))),
      "整篇没有 H1 时导读不算数")

BURIED = ("# 示例 · 指南\n\n> **版本**：v1.0\n\n## 一、正文\n\n"
          "**一句话**：导读被埋进了正文小节，读者翻到这儿的时候早就不需要它了。\n"
          "**谁该读**：把导读塞进某一节的人。\n"
          "**读完能做什么**：知道导读必须在第一个小节标题之前。\n")
check(any("缺「一句话」" in p for p in problems_for("guide.demo.md", BURIED)),
      "导读埋在第一个小节标题之后不算数（正文一开张导读就迟到了）")

AFTER_PROSE = ("# 示例 · 指南\n\n> **版本**：v1.0\n\n"
               "这是一段正文散文，它一出现就说明导读迟到了。\n\n"
               "**一句话**：导读排在整段散文后面，读者早就开始读正文了。\n"
               "**谁该读**：把导读写在正文后面的人。\n"
               "**读完能做什么**：知道导读必须排在任何正文之前。\n")
check(any("缺「一句话」" in p for p in problems_for("guide.demo.md", AFTER_PROSE)),
      "导读排在正文散文之后不算数（只挡小节标题挡不住这一种）")
META_OK = ("# 示例 · 指南\n\n> **版本**：v1.0 | **状态**：已落地\n\n"
           "> **范围**：某个边界\n\n"
           "**一句话**：版本行、范围行这类元信息不算正文，导读跟在它们后面仍然算数。\n"
           "**谁该读**：写文档头部元信息的人。\n"
           "**读完能做什么**：知道哪些行不会把导读判成迟到。\n")
check(problems_for("guide.demo.md", META_OK) == [],
      "版本行那类元信息不算正文（新判据没有误伤文档头部）")

WEEKLY_ONE_LINER = ("# 周报 2026-W30 (2026-07-20 ~ 2026-07-26)\n\n"
                    "**本周一句话**：这一周把说人话标准落地到了全部文档，闸门与棘轮同步上线。\n")
check(problems_for("report.2026-W30.md", WEEKLY_ONE_LINER) == [],
      "定期周报只要一句话就放行（读者固定，不强加另外两行）")
check([p for p in problems_for("report.cds.some-audit.md", WEEKLY_ONE_LINER) if "谁该读" in p],
      "非周报的 report 仍要三行（豁免只给 report.YYYY-WNN，不给整个前缀）")
check([p for p in problems_for("report.2026-W30-retro.md", WEEKLY_ONE_LINER) if "谁该读" in p],
      "report.2026-W30-retro 不吃周报豁免（正则要有尾锚，不能前缀匹配）")

with tempfile.TemporaryDirectory() as tmp:
    doc_dir = os.path.join(tmp, "doc")
    os.makedirs(doc_dir)
    titled = os.path.join(doc_dir, "guide.demo.md")
    with open(titled, "w", encoding="utf-8") as fh:
        fh.write('见 [说明](./guide.not-here.md "补充标题")。\n')
    check(checker.find_dead_links(titled, open(titled, encoding="utf-8").read()),
          "带标题的行内链接也验目标（不能因为多了个标题就绕过死链闸）")
    ref_style = os.path.join(doc_dir, "guide.ref.md")
    with open(ref_style, "w", encoding="utf-8") as fh:
        fh.write("见 [说明][ref]。\n\n[ref]: ./guide.not-here.md\n")
    check(checker.find_dead_links(ref_style, open(ref_style, encoding="utf-8").read()),
          "引用式链接的定义行也验目标")
    alive = os.path.join(doc_dir, "guide.alive.md")
    with open(alive, "w", encoding="utf-8") as fh:
        fh.write('见 [自己](./guide.alive.md "标题")。\n\n[me]: ./guide.alive.md\n')
    check(not checker.find_dead_links(alive, open(alive, encoding="utf-8").read()),
          "目标存在时两种写法都不误报")

SRC_EXT_SAMPLE = ("# 示例 · 指南\n\n"
                  "正文里散着 cds/web/src/components/Foo.jsx 和 cds/examples/init.sql "
                  "还有 cds/web/index.html 三处实现路径。\n")
_, sample_src = checker.scan_body(SRC_EXT_SAMPLE)
check(sample_src >= 3, f"jsx/sql/html 这些也是实现文件，要计入散落路径（实测 {sample_src} 处）")

NESTED = ("# 示例 · 指南\n\n````markdown\n```ts\n"
          "见 `doc/rule.doc.readability.md`，这行在内层示例里。\nconst a = 1;\n```\n````\n")
nested_impl, _ = checker.scan_body(NESTED)
check(nested_impl == 0,
      f"四反引号外层围栏内的示例不计入实现代码（实测算出 {nested_impl} 行）")
# 真正暴露「按三个就闭合」的是这条：外层被内层提前关掉后，后面的内容会重新
# 被当成正文，链接扫描就会伸进示例里去（Codex 指出的那一半后果）。
leaked = [line for _, line in checker.body_lines(NESTED) if "rule.doc.readability" in line]
check(not leaked, f"外层围栏不会被内层三反引号提前关掉（漏出的正文行：{leaked}）")
ATTR = "# 示例 · 指南\n\n```typescript title=\"example\"\nconst a = 1;\nconst b = 2;\n```\n"
attr_impl, _ = checker.scan_body(ATTR)
check(attr_impl == 2, f"带属性的围栏仍认得出语言（实测 {attr_impl} 行）")
check(checker.fence_lang("```ts {linenos=true}") == "ts", "花括号属性不会混进语言标记")
FAKE_CLOSE = ("# 示例 · 指南\n\n```ts\nconst a = 1;\n```not-a-close\nconst b = 2;\n```\n")
fake_impl, _ = checker.scan_body(FAKE_CLOSE)
check(fake_impl == 3, f"带后缀的 ```not-a-close 不算闭合，块内代码继续计数（实测 {fake_impl} 行）")
check(not checker.fence_closes(("`", 3), ("`", 3), "not-a-close"), "闭合围栏不许带信息串")
check(checker.fence_closes(("`", 3), ("`", 3), ""), "干净的闭合围栏仍然算闭合（没误伤）")

TILDE_IMPL = "# 示例 · 指南\n\n~~~typescript\nconst a = 1;\nconst b = 2;\n~~~\n"
BACKTICK_IMPL = TILDE_IMPL.replace("~~~", "```")
tilde_lines, _ = checker.scan_body(TILDE_IMPL)
backtick_lines, _ = checker.scan_body(BACKTICK_IMPL)
check(backtick_lines == 2, f"反引号围栏里的实现代码算得出来（实测 {backtick_lines} 行）")
check(tilde_lines == backtick_lines,
      f"波浪号围栏一视同仁（波浪号 {tilde_lines} 行 vs 反引号 {backtick_lines} 行）")
TILDE_LINK = "# 示例 · 指南\n\n~~~markdown\n见 `doc/rule.doc.readability.md`\n~~~\n"
check(not [line for _, line in checker.body_lines(TILDE_LINK) if "rule.doc.readability" in line],
      "波浪号围栏里的引用不参与链接扫描（真调 body_lines，不是空跑）")

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

# 成块 vs 夹叙：表头点名的指路列可整列跳过，叙述列不能拿来藏路径
POINTER_COL_DOC = """# 示例 · 设计

> **版本**：v1.0 | **日期**：2026-07-31 | **状态**：已落地

## 当前事实入口

| 能力 | 文件 |
|------|------|
| 取令牌 | `prd-api/src/PrdAgent.Api/Services/Foo/FooService.cs` |
"""
check(checker.scan_body(POINTER_COL_DOC)[1] == 0, "表头点名的指路列不算散落")

NARRATIVE_COL_DOC = (POINTER_COL_DOC
                     .replace("## 当前事实入口", "## 能力清单")
                     .replace("| 能力 | 文件 |", "| 能力 | 说明 |"))
check(checker.scan_body(NARRATIVE_COL_DOC)[1] == 1,
      "叙述列（说明）里的路径必须照算欠账，否则改个表头就能绕过闸门")

POINTER_ROW_DOC = """# 示例 · 债务台账

> **版本**：v1.0 | **日期**：2026-07-31 | **状态**：开发中

## 某条债务

| 状态 | open |
|------|------|
| 关联 | `cds/src/services/foo.ts` |
| 影响 | 用户看到 `cds/src/services/bar.ts` 里的旧文案 |
"""
check(checker.scan_body(POINTER_ROW_DOC)[1] == 1,
      "首列是「关联」的行算成块；同表里「影响」行的路径仍算欠账")

check(not checker._is_pointer_name("做法要点") and not checker._is_pointer_name("说明"),
      "叙述表头不得被当成指路列")
check(checker._is_pointer_name("事实入口") and checker._is_pointer_name("现成砖块"),
      "点名指路含义的短表头要被认出来")
check(not checker._is_pointer_name("这一列写的是相关文件与用途说明"),
      "长表头不算点名——指路列必须是短标签")

print("[3.55] 棘轮记到文件级，拦得住拆东墙补西墙")

# Codex review #1311 P2：只比总数的话，「修好一篇旧的 + 新增一篇不合规的」总数持平、CI 照绿。
debt = checker.per_file_debt()
check(isinstance(debt, dict) and all(
    set(v) == {"missing", "bare", "impl", "src"} for v in debt.values()),
    "逐篇欠账明细结构正确（missing/bare/impl/src）")
check(all(any(v.values()) for v in debt.values()), "零欠账的文件不进明细表")

baseline = json.load(open(os.path.join(REPO_ROOT, "scripts", "fixtures",
                                       "doc-readability-baseline.json"), encoding="utf-8"))
check("files" in baseline and baseline["files"], "基线必须记逐篇明细，否则总数持平就能偷换")
check(set(baseline["files"]) == set(debt),
      "基线的逐篇明细要与实测一致（修完存量记得 --update-baseline）")

print("[3.6] 规则与技能的轻量导读")

RULE_OK = """# 某条规则

**一句话**：这条规则要求所有颜色都走主题 token，不许在组件里裸写十六进制色值。
**什么时候撞上**：改任何带颜色的前端组件时。

正文……
"""
check(checker.check_rule_text(RULE_OK) == [], "合规规则不该报问题")
check("缺「什么时候撞上」" in checker.check_rule_text(
    RULE_OK.replace("**什么时候撞上**：改任何带颜色的前端组件时。\n", "")),
    "规则缺「什么时候撞上」必须报出来")
check(any("说不出这条规则要求什么" in x for x in checker.check_rule_text(
    RULE_OK.replace("这条规则要求所有颜色都走主题 token，不许在组件里裸写十六进制色值。", "颜色走 token。"))),
    "规则的一句话太短要报出来")

rules_total, rules_missing, _ = checker.scan_rules()
ci = open(os.path.join(REPO_ROOT, ".github", "workflows", "ci.yml"), encoding="utf-8").read()
check("'.claude/rules/**'" in ci and "'.claude/skills/**/SKILL.md'" in ci,
      "CI 的 docs 过滤要覆盖规则与技能，否则改规则不会触发这道闸")

check(rules_total >= 50, f"规则目录应被扫到（实测 {rules_total} 条）")
check(rules_missing == 0, f"现存规则应全部带导读两行（实测欠 {rules_missing} 条）")

skills_total, skills_missing, skills_detail = checker.scan_skills()
check(skills_total >= 50, f"技能目录应被扫到（实测 {skills_total} 个）")
check(skills_missing == 0, f"现存技能 frontmatter 应齐备（实测欠 {skills_missing} 个）：{skills_detail[:3]}")
# YAML 折叠块（| 与 >）里的描述必须被完整读出来，否则会把长描述误判成太短
check(checker._frontmatter_description("name: x\ndescription: |\n  " + "很长的描述" * 8) is not None
      and len(checker._frontmatter_description("name: x\ndescription: |\n  " + "很长的描述" * 8)) >= 30,
      "YAML 折叠块里的 description 要被完整取出")

RULE_FENCED = """# 某条规则

```markdown
**一句话**：这只是展示给作者看的格式示例，正文里并没有真的写导读。
**什么时候撞上**：想知道规则导读长什么样的时候。
```

## 正文
"""
check(checker.check_rule_text(RULE_FENCED) == ["缺「一句话」", "缺「什么时候撞上」"],
      "规则导读只写在代码块示例里不算数（模板不能自己骗过闸门）")

RULE_BEFORE_H1 = """**一句话**：导读跑到 H1 上面去了，读者打开先看到的是标题不是它。
**什么时候撞上**：把导读写在标题之前的时候。

# 某条规则
"""
check(checker.check_rule_text(RULE_BEFORE_H1) == ["缺「一句话」", "缺「什么时候撞上」"],
      "规则导读必须在 H1 之后（写在标题前读者看不见）")

RULE_BURIED = """# 某条规则

## 核心原则

**一句话**：导读被埋进正文小节，读者翻到这儿之前早就走了。
**什么时候撞上**：把导读写在第一个小节标题之后的时候。
"""
check(checker.check_rule_text(RULE_BURIED) == ["缺「一句话」", "缺「什么时候撞上」"],
      "规则导读埋在第一个小节标题之后不算数（与 doc/ 同一口径）")

RULE_TILDE = """# 某条规则

~~~markdown
**一句话**：这是写在波浪号围栏里的示例，不该被当成这条规则自己的导读。
**什么时候撞上**：抄模板的时候。
~~~

## 正文
"""
check(checker.check_rule_text(RULE_TILDE) == ["缺「一句话」", "缺「什么时候撞上」"],
      "波浪号围栏里的示例同样不算数（Markdown 两种围栏都合法）")

with tempfile.TemporaryDirectory() as tmp:
    empty_name = os.path.join(tmp, "SKILL.md")
    with open(empty_name, "w", encoding="utf-8") as fh:
        fh.write("---\nname:\ndescription: 这是一段足够长的描述，说清了这个技能在什么场景下会被触发、以及它会产出什么东西。\n---\n")
    check(any("空值" in p for p in checker.check_skill(empty_name)),
          "frontmatter 的 name 有键无值被抓出（空名字找不到任何技能）")

with tempfile.TemporaryDirectory() as tmp:
    skill_dir = os.path.join(tmp, "demo-skill")
    os.makedirs(skill_dir)
    wrong_name = os.path.join(skill_dir, "SKILL.md")
    body = "---\nname: %s\ndescription: 这是一段足够长的描述，说清了这个技能在什么场景下会被触发、以及它会产出什么东西。\n---\n"
    with open(wrong_name, "w", encoding="utf-8") as fh:
        fh.write(body % "unrelated-skill")
    check(any("与目录名" in p for p in checker.check_skill(wrong_name)),
          "name 与目录名对不上被抓出（name 就是技能的身份）")
    with open(wrong_name, "w", encoding="utf-8") as fh:
        fh.write("---\nname: demo-skill\nname: wrong-name\ndescription: %s\n---\n"
                 % "这是一段足够长的描述，说清了这个技能在什么场景下会被触发、以及它会产出什么东西。")
    check(any("写了多遍" in p for p in checker.check_skill(wrong_name)),
          "frontmatter 同一个键写两遍被抓出（判据看第一处、YAML 取最后一处）")
    with open(wrong_name, "w", encoding="utf-8") as fh:
        fh.write(body % "Demo_Skill")
    check(any("kebab-case" in p for p in checker.check_skill(wrong_name)),
          "name 不是 kebab-case 被抓出")
    with open(wrong_name, "w", encoding="utf-8") as fh:
        fh.write(body % "demo-skill")
    check(not checker.check_skill(wrong_name),
          "name 与目录一致且是 kebab-case 时放行（判据没有误伤）")
    with open(wrong_name, "w", encoding="utf-8") as fh:
        fh.write("---\nname: demo-skill\ndescription: # TODO: 回头再补一段说清触发时机的描述\n---\n")
    check(any("缺 description" in p for p in checker.check_skill(wrong_name)),
          "description 只写了 YAML 注释被抓出（注释在 YAML 里是 null，不是描述）")
    with open(wrong_name, "w", encoding="utf-8") as fh:
        fh.write("---\nname: demo-skill # 与目录同名\ndescription: %s\n---\n"
                 % "这是一段足够长的描述，说清了这个技能在什么场景下会被触发、以及它会产出什么东西。")
    check(not checker.check_skill(wrong_name), "值后面跟行内注释时取的是值本身（没误伤）")
    with open(wrong_name, "w", encoding="utf-8") as fh:
        fh.write("---\nname: demo-skill\ndescription: "
                 "把 Markdown 文档转换成排版精美的 PDF，支持目录、页码与水印，输出可直接打印。\n---\n")
    check(any("触发时机" in p for p in checker.check_skill(wrong_name)),
          "只讲能力不讲何时用的 description 被抓出（调度器据此选不中它）")

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

print("[6.2] 基线自己不能被本分支放宽")

# 棘轮只跟工作树比本分支的基线，于是「先制造欠账、再 --update-baseline」能让
# CI 拿放宽后的基线跟自己比。CI 因此要带 --baseline-ref 跟目标分支的基线比一次。
BASE = {"missing": {"design": 1}, "bare_refs": {}, "impl_code": {}, "source_refs": {},
        "rules_missing": 0, "skills_missing": 0, "files": {"doc/a.md": 1}}
LOOSER = {**BASE, "missing": {"design": 3}}
NEW_FILE = {**BASE, "files": {"doc/a.md": 1, "doc/b.md": 1}}
check(checker.baseline_regressions(BASE, BASE) == [], "基线没动时放行")
check(checker.baseline_regressions(BASE, LOOSER), "把计数改大会被抓出")
check(checker.baseline_regressions(BASE, NEW_FILE), "把新欠账文件写进基线会被抓出")
check(checker.load_baseline_at("这个-ref-不存在") is None, "取不到目标分支基线时返回 None，不误判")
check(not checker.git_ref_exists("这个-ref-不存在"), "认得出「ref 压根不存在」")
check(checker.git_ref_exists("HEAD"), "认得出存在的 ref（判据不是恒假）")
bogus = subprocess.run(
    [sys.executable, os.path.join(REPO_ROOT, "scripts", "doc-readability-check.py"),
     "--ratchet", "--baseline-ref", "这个-ref-不存在"],
    cwd=REPO_ROOT, capture_output=True, text=True)
check(bogus.returncode != 0 and "取不到用于对照" in bogus.stderr,
      "取不到对照基线时闸门判失败（静默降级等于把这道闸关掉）")
MOVED = {**BASE, "files": {"doc/a.md": {"missing": 2}}}
BASE_DETAIL = {**BASE, "files": {"doc/a.md": {"missing": 1}}}
check(checker.baseline_regressions(BASE_DETAIL, MOVED),
      "逐篇明细被放宽会被抓出（债务在文件之间挪位，总数持平也不算）")

with open(os.path.join(REPO_ROOT, ".github", "workflows", "ci.yml"), encoding="utf-8") as fh:
    ci_src = fh.read()
check("--baseline-ref" in ci_src, "CI 真的带上了 --baseline-ref（否则这段等于没接线）")
check("github.event.before" in ci_src,
      "push 到 main 时基线比的是推送前那个 commit（base_ref 为空时不能比到自己头上）")
check("origin/base\" || true" not in ci_src and "refs/remotes/origin/base\" || true" not in ci_src,
      "取对照基线的 fetch 不吞错（吞了就会退回拿本分支基线跟自己比）")
check(any(line.strip() == "- '**'" for line in ci_src.splitlines()),
      "docs filter 覆盖全仓（守卫扫的是全仓 git 跟踪文件，列举根目录必然列漏）")

print()

print("[6.4] 代码注释里的文档指路都点得到")

# 台账合并后，代码注释里的 doc/xxx.md 面包屑会指向已删除的册子。人跟着注释走
# 却落空，比没有注释更糟 —— 所以扫一遍源码里的文档引用，逐个验存在。
DOC_REF = re.compile(r"doc/([a-z][\w.-]*\.md)")
# 两类不算数：① 引用的文档在本仓库历史里从未存在过（更早的重命名遗留，定位不到
# 目标，不许凭空指一个）；② 测试用例里现编的示例文件名。都写清楚，不做模糊放过。
KNOWN_ROTTEN = {"plan.cds-shared-service-extension.md", "plan.cds-github-integration-followups.md",
                "debt.cds-removed-branch-pages.md", "status.cds-agent-current-progress.md"}
FIXTURE_NAMES = {"x.md", "guide.md", "sample.md", "visible.md", "design.foo.md", "guide.current.md",
                 "a.md", "b.md", "xxx.md", "demo.md",
                 # 命名模式而非具体文件（周报文件名的占位写法）
                 "report.YYYY-WXX.md", "report.YYYY-WNN.md",
                 # 命名规则里的反面示范（存在才奇怪）
                 "output-xxx.md", "notes-temp.md", "report-agent.md"}
# 不再列扩展名 —— 列举必然列漏（html 模板、生成的 json 里都真有 doc/ 面包屑）。
# 改成「凡是能按 UTF-8 读出来的 git 跟踪文件都扫」，二进制自然被 decode 挡掉。
SKIP_PREFIXES = ("scripts/tests/", "doc/", "changelogs/", "CHANGELOG.md")  # 已冻结的历史记录不改
tracked = subprocess.run(["git", "ls-files"], cwd=REPO_ROOT,
                         capture_output=True, text=True).stdout.split()
dangling: dict[str, set[str]] = {}
scanned = 0
for rel in tracked:
    if rel.startswith(SKIP_PREFIXES):
        continue  # 守卫自己的示例文件名、以及文档之间的互引（另有死链闸管）
    try:
        body = open(os.path.join(REPO_ROOT, rel), encoding="utf-8").read()
    except (OSError, UnicodeDecodeError, IsADirectoryError):
        continue
    scanned += 1
    for hit in DOC_REF.finditer(body):
        target = hit.group(1)
        if target in KNOWN_ROTTEN or target in FIXTURE_NAMES:
            continue
        if not os.path.exists(os.path.join(REPO_ROOT, "doc", target)):
            dangling.setdefault(target, set()).add(rel)
check(scanned > 3000, f"面包屑扫描覆盖全仓可读文本文件（实测 {scanned} 个）")
check(not dangling,
      f"代码注释里的 doc/ 指路都存在（落空：{ {k: sorted(v)[:2] for k, v in list(dangling.items())[:3]} }）")

print()

print("[6.5] 两份目录里的标题跟得上 H1")

# 改了文档标题却忘了改目录，doc/index.yml（外部同步消费）和 guide.list.directory.md
# （人类索引）就会对外发布一个已经不存在的标题。两份都是从 H1 派生的副本，
# 副本不刷新等于没改（config-runtime-drift 的文档版）。
def _h1(path: str) -> str:
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            if line.startswith("# "):
                return line[2:].strip()
    return ""


doc_dir = os.path.join(REPO_ROOT, "doc")
titles = {name[:-3]: _h1(os.path.join(doc_dir, name))
          for name in os.listdir(doc_dir) if name.endswith(".md")}
with open(os.path.join(doc_dir, "index.yml"), encoding="utf-8") as fh:
    index_src = fh.read()
with open(os.path.join(doc_dir, "guide.list.directory.md"), encoding="utf-8") as fh:
    list_src = fh.read()

index_keys = {m.group(1) for m in re.finditer(r'^\s{2}([a-z][\w.-]+):\s*"', index_src, re.M)}
# 只认目录条目行：`- [标题](./x.md) `key``。正文里顺手带的链接不算「已登记」，
# 否则一篇只在导语里被提了一嘴、却没进分类清单的文档会被判成已收录。
CATALOG_ENTRY = re.compile(r"^- \[(?P<title>[^\]]+)\]\(\./(?P<key>[\w.-]+)\.md\)\s+`(?P=key)`\s*$", re.M)
catalog = {m.group("key"): m.group("title") for m in CATALOG_ENTRY.finditer(list_src)}
list_keys = set(catalog)
doc_keys = set(titles)
# 只比标题会漏掉「压根没登记」的那一类：新文档不进目录时，标题比对因为找不到
# 链接而静默跳过，两份索引各少一篇而 CI 全绿（形状 1：判据比它该管的范围窄）。
# 台账合并时按「文中出现已交付/已解决」下沉条目，会把状态其实是 open 的活账
# 误埋进「已结清」——读者扫到那一节会以为这笔账还完了。
settled_open: list[str] = []
for name in sorted(os.listdir(doc_dir)):
    if not name.startswith("debt.") or not name.endswith(".md"):
        continue
    ledger = open(os.path.join(doc_dir, name), encoding="utf-8").read()
    pos = ledger.find("## 已结清")
    if pos < 0:
        continue
    settled = ledger[pos:]
    for entry in re.finditer(r"^### (.+)$", settled, re.M):
        window = settled[entry.end():entry.end() + 600]
        status = re.search(r"\|\s*状态\s*\|\s*([^|]+)\|", window)
        if status and status.group(1).strip().lower().startswith("open"):
            settled_open.append(f"{name}::{entry.group(1)}")
check(not settled_open, f"「已结清」区里没有状态仍是 open 的活账（误埋：{settled_open[:3]}）")

check(not (doc_keys - index_keys), f"每篇 doc 都登记进 index.yml（漏登：{sorted(doc_keys - index_keys)[:5]}）")
check(not (index_keys - doc_keys), f"index.yml 没有幽灵条目（幽灵：{sorted(index_keys - doc_keys)[:5]}）")
check(not (doc_keys - list_keys), f"每篇 doc 都登记进 guide.list（漏登：{sorted(doc_keys - list_keys)[:5]}）")
check(not (list_keys - doc_keys), f"guide.list 没有幽灵条目（幽灵：{sorted(list_keys - doc_keys)[:5]}）")
check(len(doc_keys) > 100, f"成员集比对读到的是真实文档集（实测 {len(doc_keys)} 篇）")

index_drift = [k for k, t in re.findall(r'^\s{2}([a-z][\w.-]+):\s*"(.*)"\s*$', index_src, re.M)
               if k in titles and titles[k] and t != titles[k]]
check(not index_drift, f"doc/index.yml 的标题与 H1 一致（漂移：{index_drift[:5]}）")

list_drift = [k for k, title in titles.items()
              if title and k in catalog and catalog[k] != title]
check(not list_drift, f"guide.list.directory.md 的标题与 H1 一致（漂移：{list_drift[:5]}）")
# 反向用例：换一个不存在的标题，检查必须报漂 —— 否则上面两条等于空跑
check(catalog.get("rule.doc.readability") == titles["rule.doc.readability"],
      "标题比对读的是目录条目里的真实标题（不是恒真断言）")
check(len(catalog) > 300, f"目录条目解析到了全部条目（实测 {len(catalog)} 条）")

print()

check(any(".Codex" in d for d in checker.RULE_DIRS),
      "规则扫描覆盖 Codex 侧规则目录（少扫一处那一处就能绕开导读要求）")
check(any(".agents" in d for d in checker.SKILL_DIRS),
      "技能扫描覆盖 Codex 侧技能根（.agents/skills 里也有真实技能）")
skill_total, skill_missing, _ = checker.scan_skills()
check(skill_total >= 60, f"两处技能根都扫到了（实测 {skill_total} 个）")
check(skill_missing == 0, f"两处技能根合起来零欠账（实测 {skill_missing} 个）")
_, codex_missing, _ = checker.scan_rules()
check(codex_missing == 0, f"两处规则目录合起来零欠账（实测 {codex_missing} 条）")

print("[7] 这道闸看得见守卫读的每一个文件")

# `.claude/rules/predicate-and-wiring-discipline.md` 形状 7：守卫接进了 CI，
# 但 CI 那道闸有 path filter，被守的文件不在 filter 里——于是只改被守文件、
# 不碰守卫本身的那种 PR 一路全绿，守卫从落地那天起就对它要防的场景不设防。
# 所以守卫自己解析 filter，断言它读的每个文件都被看着；日后新增被守对象时
# 忘了改 filter，这里会红，而不是静默失去覆盖。
GUARDED_INPUTS = [
    "doc/rule.doc.readability.md",
    ".Codex/rules/production-release-safety.md",
    ".claude/rules/predicate-and-wiring-discipline.md",
    ".claude/skills/cds/SKILL.md",
    ".claude/skills/weekly-update-summary/reference/report-template.md",
    ".claude/skills/weekly-update-summary/reference/report-template-html.html",
    ".claude/skills/daily-report-summary/reference/report-template-html.html",
    "doc/index.yml",
    "doc/guide.list.directory.md",
    "scripts/doc-readability-check.py",
    "scripts/fixtures/doc-readability-baseline.json",
    "scripts/tests/doc-readability-ratchet.test.py",
]


def _docs_filter_patterns() -> list[str]:
    """从 ci.yml 抠出 docs 这一组 filter 的 glob 列表。"""
    with open(os.path.join(REPO_ROOT, ".github", "workflows", "ci.yml"), encoding="utf-8") as fh:
        lines = fh.read().splitlines()
    out: list[str] = []
    inside = False
    for line in lines:
        stripped = line.strip()
        if stripped == "docs:":
            inside = True
            continue
        if inside:
            if stripped.startswith("- '") and stripped.endswith("'"):
                out.append(stripped[3:-1])
            elif stripped and not stripped.startswith("#"):
                break
    return out


def _covered(path: str, patterns: list[str]) -> bool:
    for pat in patterns:
        rx = "".join("[^/]*" if part == "*" else ".*" if part == "**" else re.escape(part)
                     for part in re.split(r"(\*\*|\*)", pat))
        if re.fullmatch(rx, path):
            return True
    return False


patterns = _docs_filter_patterns()
check(len(patterns) >= 5, f"能从 ci.yml 解析出 docs filter（实测 {len(patterns)} 条）")
uncovered = [p for p in GUARDED_INPUTS if not _covered(p, patterns)]
check(not uncovered, f"守卫读的文件全部在 docs filter 里（漏网：{uncovered}）")
# 反向用例：把兜底的 '**' 与模板那条 filter 都拿掉，覆盖检查必须立刻报缺 ——
# 否则「守卫读的文件都被看着」那条断言等于空跑
without = [p for p in patterns if p != "**" and "weekly-update-summary" not in p]
check(not _covered(".claude/skills/weekly-update-summary/reference/report-template.md", without),
      "去掉相关 filter 后覆盖检查会报缺（说明这段没有空跑）")
check(_covered("prd-api/tests/PrdAgent.Tests/SomeGuardTests.cs", patterns),
      "全仓兜底真的覆盖到任意一棵源码树")
check(all(os.path.exists(os.path.join(REPO_ROOT, p)) for p in GUARDED_INPUTS),
      "被守文件都真实存在（改名后这里会红，提醒同步 filter）")


if failures:
    print(f"FAILED: {len(failures)} 项")
    sys.exit(1)
print("PASSED")
