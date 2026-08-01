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
# 「加粗标签 + 冒号」这个形状不足以判定是元信息：正文小节也长这样
PROSE_LABEL = ("# 示例 · 指南\n\n> **版本**：v1.0\n\n"
               "**背景**：这是一段正文，它一出现就说明导读迟到了。\n\n"
               "**一句话**：导读排在一段背景之后，读者早就开始读正文了。\n"
               "**谁该读**：把导读写在背景段后面的人。\n"
               "**读完能做什么**：知道加粗标签不等于元信息。\n")
check(any("缺「一句话」" in p for p in problems_for("guide.demo.md", PROSE_LABEL)),
      "`**背景**：` 这类正文标签不算元信息（不能只按加粗形状放行）")
check(checker.is_header_meta("**关联设计**：某文档") and checker.is_header_meta("**适用版本**：v2"),
      "关联/适用这类元信息标签仍放行（没误伤存量头部写法）")
check(not checker.is_header_meta("**概述**：一段话"), "概述这类正文标签不放行")

WEEKLY_ONE_LINER = ("# 周报 2026-W30 (2026-07-20 ~ 2026-07-26)\n\n"
                    "**本周一句话**：这一周把说人话标准落地到了全部文档，闸门与棘轮同步上线。\n")
check(problems_for("report.2026-W30.md", WEEKLY_ONE_LINER) == [],
      "定期周报只要一句话就放行（读者固定，不强加另外两行）")
check([p for p in problems_for("report.cds.some-audit.md", WEEKLY_ONE_LINER) if "谁该读" in p],
      "非周报的 report 仍要三行（豁免只给 report.YYYY-WNN，不给整个前缀）")
check([p for p in problems_for("report.2026-W30-retro.md", WEEKLY_ONE_LINER) if "谁该读" in p],
      "report.2026-W30-retro 不吃周报豁免（正则要有尾锚，不能前缀匹配）")
ALIAS_ABUSE = ("# 示例 · 指南\n\n**本周一句话**：非周报文档拿周报的别名顶替标准字段，应当判缺。\n"
               "**谁该读**：验证判据的人。\n**读完能做什么**：确认别名不外溢。\n")
check(any("缺「一句话」" in p for p in problems_for("guide.demo.md", ALIAS_ABUSE)),
      "「本周一句话」这个别名只给周报（别的文档拿它顶替标准字段不算数）")
LONG_ONE = "判据额度验证用的长句子，" * 11
check(any("超过 100 字上限" in p for p in problems_for(
        "report.cds.audit.md",
        f"# t\n\n**一句话**：{LONG_ONE}\n**谁该读**：验证的人。\n**读完能做什么**：确认额度。\n")),
      "140 字额度只给周报文件名，非周报仍按 100 字判")
check(not [p for p in problems_for("report.2026-W30.md", f"# t\n\n**本周一句话**：{LONG_ONE}\n")
           if "上限" in p],
      "周报本身仍享受 140 字额度（没误伤）")

KNOWN_ONE = {"rule.doc.naming.md"}
check(len(checker.find_bare_refs("# t\n\n详见 rule.doc.naming.md 里的命名规则。\n", KNOWN_ONE)) == 1,
      "连反引号都没加的裸文档名也算裸引用（它一样点不开）")
check(not checker.find_bare_refs("# t\n\n详见 [命名规则](./rule.doc.naming.md)。\n", KNOWN_ONE),
      "已经是链接的不误报")
check(not checker.find_bare_refs("# t\n\n```text\n详见 rule.doc.naming.md\n```\n", KNOWN_ONE),
      "代码块里的示例不误报")
check(not checker.find_bare_refs("# t\n\n详见 rule.does-not-exist.md。\n", KNOWN_ONE),
      "指向不存在文档的名字不算裸引用（命名规则里的反面示范不被误伤）")
check(len(checker.find_bare_refs("# t\n\n请阅读 doc/rule.doc.naming.md。\n", KNOWN_ONE)) == 1,
      "带 doc/ 路径前缀的裸名同样算（负向前瞻别把它挡在外面）")
_, agents_skill = checker.scan_body("# t\n\n见 `.agents/skills/x/scripts/run.py` 这个脚本。\n")
check(agents_skill == 1, f"Codex 技能根下的实现路径也计入散落（实测 {agents_skill} 处）")
check(checker.nested_docs() == [], f"doc/ 当前是扁平的（子目录里的 .md：{checker.nested_docs()[:3]}）")
nested_probe = os.path.join(REPO_ROOT, "doc", "samples", "notes.md")
try:
    os.makedirs(os.path.dirname(nested_probe), exist_ok=True)
    with open(nested_probe, "w", encoding="utf-8") as fh:
        fh.write("# 探针\n\n正文。\n")
    check(any("samples/notes.md" in x for x in checker.nested_docs()),
          "子目录里的文档会被发现（非递归列目录时它连查都不会被查）")
    nested_run = subprocess.run(
        [sys.executable, os.path.join(REPO_ROOT, "scripts", "doc-readability-check.py"), "--ratchet"],
        cwd=REPO_ROOT, capture_output=True, text=True)
    check(nested_run.returncode != 0 and "必须保持扁平" in nested_run.stderr,
          "doc/ 出现子目录文档时闸门判失败")
finally:
    if os.path.exists(nested_probe):
        os.remove(nested_probe)
    if os.path.isdir(os.path.dirname(nested_probe)) and not os.listdir(os.path.dirname(nested_probe)):
        os.rmdir(os.path.dirname(nested_probe))
check(not checker.find_bare_refs(
        "# t\n\n见 [doc/rule.doc.naming.md](./rule.doc.naming.md)。\n", KNOWN_ONE),
      "链接文字里带 doc/ 前缀时不误报")
fixed_code_span, n_code = checker.fix_links("见 `doc/rule.doc.naming.md §5` 的约束。\n", KNOWN_ONE)
check(n_code == 0 and "](" not in fixed_code_span,
      "行内代码里的引用不被自动改写（往 code span 里塞链接会渲染成字面量）")

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

# 隐藏目录（.claude/.github/.Codex）的路径在文档里通常被反引号包着，
# \b 在「反引号 + 点」这种非词字符之间不成立 —— 词边界必须换成「前面不是路径字符」。
_, dot_in_code = checker.scan_body("# 示例 · 指南\n\n见 `.claude/skills/x/run.py` 这个脚本。\n")
check(dot_in_code == 1, f"反引号包着的隐藏目录路径算得出来（实测 {dot_in_code} 处）")
_, dot_bare = checker.scan_body("# 示例 · 指南\n\n见 .github/workflows/ci.yml 这个工作流。\n")
check(dot_bare == 1, f"裸写的隐藏目录路径同样算（实测 {dot_bare} 处）")
_, nested = checker.scan_body("# 示例 · 指南\n\n见 vendor/cds/src/index.ts 这个第三方副本。\n")
check(nested == 0, "更长路径里的同名片段不算根（新边界没把误判带进来）")

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
check(not checker.fence_closes(("`", 3), ("`", 3), checker.fence_info("```{}")),
      "```{} 不算闭合（闭合判定要看原始后缀，不能看归一化后的语言标记）")
check(not checker.fence_closes(("`", 3), ("`", 3), checker.fence_info('```""')),
      '```"" 不算闭合（同上）')
brace_impl, _ = checker.scan_body("# 示例 · 指南\n\n```ts\nconst a = 1;\n```{}\nconst b = 2;\n```\n")
check(brace_impl == 3, f"被 ```{{}} 假闭合骗过去的话代码会漏计（实测 {brace_impl} 行）")
check(checker.fence_closes(("`", 3), ("`", 3), ""), "干净的闭合围栏仍然算闭合（没误伤）")

# 缩进四格起就是缩进代码块，不是围栏。认了它，一段缩进示例就能把后面的正文
# 整段藏进「块内」，死链闸门扫不到那些行还照样报绿。
INDENTED_FENCE = ("# 示例 · 指南\n\n"
                  "    ```markdown\n"
                  "    示例里的一行\n"
                  "[坏链](./missing.md)\n")
hidden = [line for _, line in checker.body_lines(INDENTED_FENCE) if "missing.md" in line]
check(hidden, "四格缩进的 ``` 不算围栏，后面的死链藏不住")
check(checker.fence_delim("    ```ts") is None, "四格缩进不是围栏")
# 制表符同样构成缩进代码块（CommonMark 把 tab 展开成四格）
TAB_HEADER = ("\t# 看起来像标题 · 指南\n"
              "\t**一句话**：这三行用制表符缩进，渲染出来同样是一块代码。\n"
              "\t**谁该读**：拿制表符糊弄闸门的人。\n"
              "\t**读完能做什么**：知道 tab 缩进也不算数。\n")
check(any("缺「一句话」" in p for p in problems_for("guide.demo.md", TAB_HEADER)),
      "制表符缩进的假标题与假导读同样不算数")
check(checker.INDENTED_CODE.match("\t示例") and not checker.INDENTED_CODE.match("  两格"),
      "缩进代码块判据认制表符、不误伤两格缩进")
check(checker.fence_delim("   ```ts") is not None, "三格以内仍是围栏（没误伤列表里的围栏）")

# 缩进代码块里的假标题与假导读：渲染出来是代码，读者看不到标题也看不到导读
INDENTED_HEADER = ("    # 看起来像标题 · 指南\n"
                   "    **一句话**：这三行整段缩进四格，渲染出来是一块代码而不是导读。\n"
                   "    **谁该读**：想拿缩进糊弄闸门的人。\n"
                   "    **读完能做什么**：知道缩进代码块里的导读不算数。\n")
check(any("缺「一句话」" in p for p in problems_for("guide.demo.md", INDENTED_HEADER)),
      "缩进四格的假标题与假导读不算数（渲染出来是代码块）")

# 引用块里的围栏照样是围栏：不剥这层前缀，实现代码往引用块一放就绕过棘轮
QUOTED_FENCE = "# 示例 · 指南\n\n> ```ts\n> const a = 1;\n> const b = 2;\n> ```\n"
quoted_impl, _ = checker.scan_body(QUOTED_FENCE)
check(quoted_impl == 2, f"引用块里的实现代码照样计数（实测 {quoted_impl} 行）")
check(checker.fence_delim("> ```ts") is not None, "引用块前缀不挡围栏识别")

# shell：几步命令是指南本职，成脚本就该搬进 scripts/
STEPS = "# 示例 · 指南\n\n```bash\ncd prd-api\ndotnet build\ndotnet test\n```\n"
steps_impl, _ = checker.scan_body(STEPS)
check(steps_impl == 0, f"几步命令序列不算实现代码（实测 {steps_impl} 行）")
LONG_SH = "# 示例 · 指南\n\n```bash\n" + "".join(f"echo {i}\n" for i in range(20)) + "```\n"
long_impl, _ = checker.scan_body(LONG_SH)
check(long_impl == 20, f"超过 12 行的 shell 按实现计数（实测 {long_impl} 行）")
CTRL_SH = "# 示例 · 指南\n\n```bash\nfor f in *.md; do\n  echo $f\ndone\n```\n"
ctrl_impl, _ = checker.scan_body(CTRL_SH)
check(ctrl_impl == 3, f"带控制流的 shell 按实现计数（实测 {ctrl_impl} 行）")
check(checker.shell_script_lines("ts", ["for x in y; do", "done"]) == 0,
      "非 shell 语言不走 shell 判据（各算各的，不重复计数）")
# 没写闭合行的围栏在 Markdown 里一直开到文末，缓冲里的块也得结算
UNCLOSED_SH = "# 示例 · 指南\n\n```bash\n" + "".join(f"echo {i}\n" for i in range(20))
unclosed_impl, _ = checker.scan_body(UNCLOSED_SH)
check(unclosed_impl == 20, f"没闭合的 shell 围栏在文末结算（实测 {unclosed_impl} 行）")

# 列表项里的围栏（- ```ts / 1. ```ts）同样是围栏
LIST_FENCE = "# 示例 · 指南\n\n- ```ts\n  const a = 1;\n  const b = 2;\n  ```\n"
list_impl, _ = checker.scan_body(LIST_FENCE)
check(list_impl == 2, f"列表项里的实现代码照样计数（实测 {list_impl} 行）")
for prefix in ("- ```ts", "1. ```ts", "> - ```ts", "  * ```ts"):
    check(checker.fence_delim(prefix) is not None, f"「{prefix}」认得出是围栏")
check(checker.fence_delim("正文里的 - 号不是列表") is None, "散文里的连字符不会被当成列表前缀")

# 仓库根上的入口文件没有目录前缀，要求「目录/」的判据一个都认不出来
check(checker.count_source_refs("先看 exec_dep.sh 再看 quick.ps1") == 2,
      "根上的入口脚本算散落源码引用")
check(checker.count_source_refs("改 cds-compose.yml 就行") == 1, "根上的 compose 文件同样算")
check(checker.count_source_refs("见 cds/scripts/run.sh 一处") == 1,
      "带目录的路径不会被根判据重复计数")
check(checker.count_source_refs("这句话里没有任何路径") == 0, "普通句子不误报")
check(checker.count_source_refs("见 prd-admin/src/a.ts:10 这一处") == 1,
      "带行号的路径只算一处（路径与行号引用不重复计数）")
check(checker.count_source_refs("见 a.ts:10 光有行号") == 1, "光有行号的引用仍算一处")

# 改写端的跳过范围必须与检测端一致，否则批量改写会动判据故意放过的示例
FIX_SCOPE = ("# t\n\n正文一段。\n\n    示例里提到 rule.doc.readability.md 这一处\n\n"
             "- 列表\n  - 见 rule.doc.readability.md 这一处\n")
fixed_text, fixed_n = checker.fix_links(FIX_SCOPE, {"rule.doc.readability.md"})
check(fixed_n == 1 and "    示例里提到 rule.doc.readability.md" in fixed_text,
      f"--fix-links 不动顶层缩进代码块，只改列表里的那处（实测改了 {fixed_n} 处）")

# 顶层缩进代码块不是正文；列表里的缩进续行仍是正文（一刀切会把嵌套列表里的死链藏起来）
TOP_INDENTED = "# t\n\n正文一段。\n\n    [示例](./does-not-exist.md)\n"
check(not [l for _, l in checker.body_lines(TOP_INDENTED) if "does-not-exist" in l],
      "顶层缩进代码块里的示例链接不当正文扫")
LIST_CONT = "# t\n\n- 一级\n  - 二级\n    见 [真链接](./does-not-exist.md) 这一条\n"
check([l for _, l in checker.body_lines(LIST_CONT) if "does-not-exist" in l],
      "列表里缩进四格的续行仍算正文（真死链藏不住）")

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
RULE_AFTER_PROSE = """# 某条规则

这是一段正文散文，它一出现就说明导读迟到了。

**一句话**：导读排在散文后面，读者早就开始读正文了。
**什么时候撞上**：把导读写在正文后面的时候。
"""
check(checker.check_rule_text(RULE_AFTER_PROSE) == ["缺「一句话」", "缺「什么时候撞上」"],
      "规则导读排在正文散文之后同样不算数（两处扫描共用一个实现）")
check(checker.parse_header.__doc__ and "header_lines" in checker.check_rule_text.__doc__,
      "规则校验明写了与 doc/ 共用扫描口径（防止日后又各写一份）")

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
    # 语法先于内容：frontmatter 本身是坏 YAML 的话，宿主根本加载不到这个技能，
    # 判据却因为自己手写解析而对着一段读得挺顺的描述报绿。
    with open(wrong_name, "w", encoding="utf-8") as fh:
        fh.write("---\nname: demo-skill\ndescription: Use when: 用户要导出报表，"
                 "或者说「导出」「出个表」这类话时触发，产出一份可下载的表格。\n---\n")
    check(any("不是合法 YAML" in p for p in checker.check_skill(wrong_name)),
          "description 里没加引号的「: 」被抓出（YAML 解析器会当成嵌套键直接报错）")
    with open(wrong_name, "w", encoding="utf-8") as fh:
        fh.write("---\nname: demo-skill\ndescription: 'Use when: 用户要导出报表，"
                 "或者说「导出」「出个表」这类话时触发，产出一份可下载的表格。'\n---\n")
    check(not checker.check_skill(wrong_name),
          "整句用引号包起来就放行（没误伤把触发词写成「Trigger words:」的正常写法）")
    with open(wrong_name, "w", encoding="utf-8") as fh:
        fh.write('---\nname: demo-skill\ndescription: "用户说导出报表时触发，'
                 '产出一份可下载的表格；路径写成 C:\\q 这种 YAML 不认的转义。"\n---\n')
    check(any("不是合法 YAML" in p for p in checker.check_skill(wrong_name)),
          "引号标量里 YAML 不认的转义被抓出（判定得真接进 check_skill，不能只写个函数）")
    # 宿主解析的是整份 frontmatter：别的键写坏了，技能同样加载不了
    good_desc = "这是一段足够长的描述，说清了这个技能在什么场景下会被触发、以及它会产出什么东西。"
    with open(wrong_name, "w", encoding="utf-8") as fh:
        fh.write(f"---\nname: demo-skill\nallowed-tools: [Read, Write\ndescription: {good_desc}\n---\n")
    check(any("allowed-tools" in p and "不是合法 YAML" in p for p in checker.check_skill(wrong_name)),
          "name / description 之外的键写坏了也被抓出（宿主解析的是整份 frontmatter）")
    with open(wrong_name, "w", encoding="utf-8") as fh:
        fh.write(f"---\nname: demo-skill\nallowed-tools: [Read, Write]\ndescription: {good_desc}\n---\n")
    check(not checker.check_skill(wrong_name), "写法正确的流式集合放行（没误伤 allowed-tools 的正常写法）")
    # 只数深度不行：[Read} 的深度也回到零，而 YAML 认的是同类闭合
    check(checker.frontmatter_syntax_problem("[Read}") is not None,
          "括号不配对的流式集合被抓出（只数深度会放过 [Read}）")
    check(checker.frontmatter_syntax_problem("[a, {b: 1}]") is None,
          "嵌套且配对正确的流式集合放行")

# 手写判据要跟真 YAML 解析器对答案，否则它只是「我以为的 YAML」
YAML_CASES = [
    "普通一句话描述",
    "Use when: 用户要导出",
    "'Use when: 用户要导出'",
    '"Use when: 用户要导出"',
    "结尾有冒号:",
    "@保留字符开头",
    "&锚点开头",
    "[流式集合]",
    "值里有 http://x 这种冒号不带空格",
]
try:
    import yaml as _yaml
except ImportError:                                    # pragma: no cover
    _yaml = None
    print("  跳过 PyYAML 对答案：当前环境没装 PyYAML（判据本身不依赖它）")
if _yaml is not None:
    mismatched = []
    for case in YAML_CASES:
        try:
            _yaml.safe_load(f"description: {case}")
            yaml_ok = True
        except Exception:
            yaml_ok = False
        ours_ok = checker.plain_scalar_problem(case) is None
        # 流式集合能被 YAML 解析但结果不是字符串，判据比 YAML 严一档是有意的
        if case.startswith("[") and yaml_ok and not ours_ok:
            continue
        if yaml_ok != ours_ok:
            mismatched.append((case, yaml_ok, ours_ok))
    check(not mismatched, f"手写标量判据与 PyYAML 对得上（分歧：{mismatched}）")
    check(len(YAML_CASES) >= 8, f"对答案的用例覆盖了正反两面（实测 {len(YAML_CASES)} 条）")
    # 引号标量的转义同样要跟 PyYAML 对答案：把任意 \x 都当合法转义放行的话，
    # `\q` 这种 YAML 直接报错、宿主加载不到，判据却读到一段正常描述。
    QUOTED_CASES = [
        '"一句正常的描述"',
        '"值里有 \\q 这种 YAML 不认的转义"',
        '"换行转义 \\n 是合法的"',
        '"十六进制 \\x41 合法"',
        '"半个十六进制 \\xZZ 不合法"',
        "'单引号里 \\q 只是两个普通字符'",
        '"引号没闭合',
    ]
    quoted_mismatch = []
    for case in QUOTED_CASES:
        try:
            _yaml.safe_load(f"description: {case}")
            yaml_ok = True
        except Exception:
            yaml_ok = False
        ours_ok = checker.quoted_scalar_problem(case) is None
        if yaml_ok != ours_ok:
            quoted_mismatch.append((case, yaml_ok, ours_ok))
    check(not quoted_mismatch, f"引号标量的转义判据与 PyYAML 对得上（分歧：{quoted_mismatch}）")

check(checker.yaml_scalar('"Use when the user says \\"export\\" and wants a file"')
      == 'Use when the user says "export" and wants a file',
      "双引号标量里的转义引号不截断（截断会把合格描述冤判成太短）")
check(checker.yaml_scalar("'it''s triggered by 导出'") == "it's triggered by 导出",
      "单引号标量里的双写引号按 YAML 规则还原")

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

    stats, _, _ = checker.scan()
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
check(checker.changed_docs_since("这个-ref-不存在") is None,
      "算不出来时返回 None 而不是空表（空表会被当成「一篇没碰」，又是静默降级）")
# CI 里 fetch 的是 origin/base，本地一般只有 origin/main —— 取第一个存在的，
# 两个都没有就明确打印跳过原因，不假装跑过（空跑的绿灯比没有更糟）。
base_ref = next((r for r in ("origin/base", "origin/main") if checker.git_ref_exists(r)), "")
touched_now = checker.changed_docs_since(base_ref) if base_ref else []
if base_ref:
    check(len(touched_now) > 50,
          f"能列出本次碰过的 doc（对照 {base_ref}，实测 {len(touched_now)} 篇）")
else:
    print("  skip 「本次碰过的文档」用例：没有可对照的 base ref（origin/base / origin/main 都不在）")
still_bad = [r for r in touched_now
             if os.path.exists(os.path.join(REPO_ROOT, r))
             and not checker.WEEKLY_REPORT.match(os.path.basename(r)[:-3])
             and checker.check_file(os.path.join(REPO_ROOT, r))]
check(not still_bad, f"本次碰过的非周报文档都已补齐导读（漏网：{still_bad[:3]}）")
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
check("github.event.repository.default_branch" in ci_src,
      "手动 dispatch / 新分支首推有单独的 base 选择（否则会拿空 SHA 去 update-ref）")
check("0000000000000000000000000000000000000000" in ci_src,
      "新分支首推的全零 SHA 被排除（那不是一个可比对的 commit）")
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
# 白名单按「文件 + 目标」配对，不按目标一刀切 —— 只认目标的话，同一个死名字
# 明天出现在任何新文件里都能蒙混过关（豁免的是这几处历史遗留，不是这几个名字）。
KNOWN_ROTTEN_PAIRS = {
    ("cds/src/index.ts", "debt.cds-removed-branch-pages.md"),
    ("cds/src/routes/remote-hosts.ts", "plan.cds-shared-service-extension.md"),
    ("cds/src/services/sidecar/sidecar-deployer.ts", "plan.cds-shared-service-extension.md"),
    ("cds/src/services/state.ts", "plan.cds-shared-service-extension.md"),
    ("cds/src/types.ts", "plan.cds-github-integration-followups.md"),
    ("cds/src/types.ts", "plan.cds-shared-service-extension.md"),
    ("cds/web/src/pages/cds-settings/tabs/RemoteHostsTab.tsx", "plan.cds-shared-service-extension.md"),
    ("prd-admin/src/pages/infra-services/InfraServicesPage.tsx", "plan.cds-shared-service-extension.md"),
    ("prd-api/src/PrdAgent.Core/Interfaces/IDynamicSidecarRegistry.cs", "plan.cds-shared-service-extension.md"),
    ("prd-api/src/PrdAgent.Infrastructure/Services/ClaudeSidecar/ClaudeSidecarOptions.cs", "plan.cds-shared-service-extension.md"),
}
FIXTURE_NAMES = {"x.md", "guide.md", "sample.md", "visible.md", "design.foo.md", "guide.current.md",
                 "a.md", "b.md", "xxx.md", "demo.md",
                 # 命名模式而非具体文件（周报文件名的占位写法）
                 "report.YYYY-WXX.md", "report.YYYY-WNN.md",
                 # 命名规则里的反面示范（存在才奇怪）
                 "output-xxx.md", "notes-temp.md", "report-agent.md"}
# 不再列扩展名 —— 列举必然列漏（html 模板、生成的 json 里都真有 doc/ 面包屑）。
# 改成「凡是能按 UTF-8 读出来的 git 跟踪文件都扫」，二进制自然被 decode 挡掉。
SKIP_PREFIXES = ("scripts/tests/", "doc/", "changelogs/", "CHANGELOG.md")  # 已冻结的历史记录不改
# -z 不能省：中文名 / 带空格的路径会被 git 加引号转义，按空白切分喂给 open()
# 只会静默失败 —— 32 个真实跟踪文件因此从没被扫过，而守卫照样报绿。
tracked = [p for p in subprocess.run(["git", "ls-files", "-z"], cwd=REPO_ROOT,
                                     capture_output=True, text=True).stdout.split("\0") if p]
# 每条路径都必须真实存在：按空白切分时，中文名/带空格的路径会碎成不存在的
# 片段，open() 静默失败，扫描少扫几十个文件却照样报绿。
broken_paths = [p for p in tracked if not os.path.exists(os.path.join(REPO_ROOT, p))]
check(not broken_paths, f"git 列出的每条路径都能直接打开（碎片：{broken_paths[:3]}）")

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
        if (rel, target) in KNOWN_ROTTEN_PAIRS or target in FIXTURE_NAMES:
            continue
        if not os.path.exists(os.path.join(REPO_ROOT, "doc", target)):
            dangling.setdefault(target, set()).add(rel)
check(scanned > 3000, f"面包屑扫描覆盖全仓可读文本文件（实测 {scanned} 个）")

# 白名单本身也要防腐：配对里的文件若已不再引用那个名字，就该把这条删掉
stale_pairs = [(f, tgt) for f, tgt in KNOWN_ROTTEN_PAIRS
               if not os.path.exists(os.path.join(REPO_ROOT, f))
               or f"doc/{tgt}" not in open(os.path.join(REPO_ROOT, f), encoding="utf-8",
                                           errors="ignore").read()]
check(not stale_pairs, f"历史遗留白名单里没有已经失效的条目（可删：{stale_pairs[:3]}）")
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



def _yaml_block(src: str, key: str) -> str:
    """截出顶层 `key:` 底下那一段（到下一个顶行开头为止）。

    外部同步工具只读 docs:，所以「有没有登记」只能按 docs: 里的成员算。
    整份文件通配的话，某篇文档挪进 aliases: 之类的别处也会被判成已登记，
    而消费者那边其实读不到它（形状 1：判据比它该管的范围宽）。
    """
    m = re.search(rf"^{re.escape(key)}:[ \t]*$", src, re.M)
    if not m:
        return ""
    rest = src[m.end():]
    stop = re.search(r"^\S", rest, re.M)
    return rest[:stop.start()] if stop else rest


INDEX_ENTRY = re.compile(r'^\s{2}([a-z][\w.-]+):\s*"(.*)"\s*$', re.M)
docs_block = _yaml_block(index_src, "docs")
index_keys = {m.group(1) for m in INDEX_ENTRY.finditer(docs_block)}
# 合成用例：只在别的顶层块里露脸的 key 不算登记，docs: 里的才算
SAMPLE_YML = ('folders:\n  - prefix: spec\n'
              'docs:\n  spec.real: "真的登记了"\n'
              'aliases:\n  spec.fake: "只在别处露脸"\n')
sample_keys = {m.group(1) for m in INDEX_ENTRY.finditer(_yaml_block(SAMPLE_YML, "docs"))}
check(sample_keys == {"spec.real"},
      f"index.yml 成员只认 docs: 段（合成用例实测 {sorted(sample_keys)}）")
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
def settled_residuals(ledger: str) -> list[str]:
    """「已结清」区里还没做完的账。三种形状都要认，只认第一种等于没判：

    1. 小节的元信息行写着「状态 | open」；
    2. 小节标题自己带着（open）；
    3. 主行标 done、尾巴留在别的列（「残留边界 / 残留： / 遗留：」）——
       这一种最隐蔽，读者扫到「已结清」会以为这笔账真的还完了。
    """
    pos = ledger.find("## 已结清")
    if pos < 0:
        return []
    settled = ledger[pos:]
    hits: list[str] = []
    for entry in re.finditer(r"^### (.+)$", settled, re.M):
        window = settled[entry.end():entry.end() + 600]
        status = re.search(r"\|\s*状态\s*\|\s*([^|]+)\|", window)
        if status and status.group(1).strip().lower().startswith("open"):
            hits.append(entry.group(1))
        if re.search(r"[（(]open[）)]", entry.group(1), re.I):
            hits.append(f"{entry.group(1)}（标题写着 open）")
    for row in re.finditer(r"^\|.+\|$", settled, re.M):
        cells = [c.strip() for c in row.group(0).strip("|").split("|")]
        if any(re.fullmatch(r"open(\(.*\))?", c, re.I) for c in cells):
            hits.append(f"{cells[0]}（行状态 open）")
        if any(("残留边界" in c or c.startswith(("残留：", "遗留："))) for c in cells):
            hits.append(f"{cells[0]}（还留着没做完的尾巴，应挪回活账区）")
    return hits


settled_open: list[str] = []
for name in sorted(os.listdir(doc_dir)):
    if not name.startswith("debt.") or not name.endswith(".md"):
        continue
    ledger = open(os.path.join(doc_dir, name), encoding="utf-8").read()
    settled_open += [f"{name}::{x}" for x in settled_residuals(ledger)]
# 嵌套链接是坏 Markdown（渲染出多余方括号、点击目标不确定），
# 多半是批量改写在链接文字里又套了一层。全库零容忍。
# 逐行匹配，且先把行内代码挖掉：`[[xxx]]` 这种 wikilink 写法常出现在
# 代码引用里，跨行通配会把它和后面的链接连成假嵌套。
NESTED_LINK = re.compile(r"\[[^\]\n]*\[[^\]\n]*\]\([^)\n]*\)[^\]\n]*\]\([^)\n]*\)")
CODE_SPAN_MASK = re.compile(r"`[^`\n]*`")
nested: list[str] = []
for name in sorted(os.listdir(doc_dir)):
    if not name.endswith(".md"):
        continue
    for line in open(os.path.join(doc_dir, name), encoding="utf-8"):
        m = NESTED_LINK.search(CODE_SPAN_MASK.sub("", line))
        if m:
            nested.append(f"{name}: {m.group(0)[:60]}")
check(not nested, f"doc/ 里没有嵌套链接（{nested[:3]}）")
check(NESTED_LINK.search("[[a](./a.md)](a.md)") is not None
      and NESTED_LINK.search("[a](./a.md) 和 [b](./b.md)") is None,
      "嵌套链接判据认得出真嵌套、不误伤同一行的两个正常链接")

check(not settled_open, f"「已结清」区里没有还没做完的账（误埋：{settled_open[:3]}）")

# 生成器的「整份覆盖写」目标不许是入库文档：文档合并时把某个已删的生成物路径
# 顺手改指了权威文档，跑一次脚本就能把那篇文档整篇冲掉（本轮真发生过）。
overwrite_docs: list[str] = []
for sh in sorted(pathlib.Path(REPO_ROOT, "scripts").glob("*.sh")):
    src = sh.read_text(encoding="utf-8", errors="replace")
    for m in re.finditer(r'^(\w+)="\$\{[^}]*:-([^"]*)\}"', src, re.M):
        var, default = m.group(1), m.group(2)
        if "/doc/" not in default:
            continue
        if re.search(rf'^\s*\}}\s*>\s*"\${var}"', src, re.M) or f'> "${var}"' in src:
            overwrite_docs.append(f"{sh.name}::{var} -> {default}")
check(not overwrite_docs, f"没有脚本把入库文档当整份覆盖写的目标（{overwrite_docs[:3]}）")
# 反向用例：把目标改回 doc/ 下的文档，这条必须报出来
PROBE_SH = ('X="${X_ENV:-$ROOT_DIR/doc/design.demo.md}"\n{\n  printf "hi"\n} > "$X"\n')
probe_hits = [m.group(1) for m in re.finditer(r'^(\w+)="\$\{[^}]*:-([^"]*)\}"', PROBE_SH, re.M)
              if "/doc/" in m.group(2) and '> "$' + m.group(1) + '"' in PROBE_SH]
check(probe_hits == ["X"], f"判据认得出「默认写进 doc/」这种形状（实测 {probe_hits}）")
# 合成用例：三种形状逐一验证，否则上面那条在台账干净时是空跑的绿灯
SETTLED_HEAD = "## 已结清（供回溯）\n\n### 某小节\n\n| # | 状态 | 债务 | 影响 |\n|---|---|---|---|\n"
check(not settled_residuals(SETTLED_HEAD + "| 1 | done | ~~某事~~ | — |\n"),
      "干净的已结清区不误报")
check(settled_residuals(SETTLED_HEAD + "| 1 | open | 某事 | — |\n"),
      "行状态写 open 的行被抓出")
check(settled_residuals("## 已结清（供回溯）\n\n### 某小节（open）\n\n正文\n"),
      "小节标题自己写着（open）被抓出")
check(settled_residuals(SETTLED_HEAD + "| 1 | done | ~~某事~~ | 残留边界：还有一半没做 |\n"),
      "主行标 done、尾巴留在别的列的被抓出（Codex 指出的那一种）")
check(not settled_residuals("## 主台账\n\n| # | 状态 |\n|---|---|\n| 1 | open |\n"),
      "活账区的 open 不算误埋（只管已结清区）")

check(not (doc_keys - index_keys), f"每篇 doc 都登记进 index.yml（漏登：{sorted(doc_keys - index_keys)[:5]}）")
check(not (index_keys - doc_keys), f"index.yml 没有幽灵条目（幽灵：{sorted(index_keys - doc_keys)[:5]}）")
check(not (doc_keys - list_keys), f"每篇 doc 都登记进 guide.list（漏登：{sorted(doc_keys - list_keys)[:5]}）")
check(not (list_keys - doc_keys), f"guide.list 没有幽灵条目（幽灵：{sorted(list_keys - doc_keys)[:5]}）")
check(len(doc_keys) > 100, f"成员集比对读到的是真实文档集（实测 {len(doc_keys)} 篇）")

index_titles = {m.group(1): m.group(2) for m in INDEX_ENTRY.finditer(docs_block)}
index_drift = [k for k, t in index_titles.items()
               if k in titles and titles[k] and t != titles[k]]
check(not index_drift, f"doc/index.yml 的标题与 H1 一致（漂移：{index_drift[:5]}）")
check(len(index_titles) > 100, f"标题比对读到的是 docs: 全段（实测 {len(index_titles)} 条）")

list_drift = [k for k, title in titles.items()
              if title and k in catalog and catalog[k] != title]
check(not list_drift, f"guide.list.directory.md 的标题与 H1 一致（漂移：{list_drift[:5]}）")
# 反向用例：换一个不存在的标题，检查必须报漂 —— 否则上面两条等于空跑
check(catalog.get("rule.doc.readability") == titles["rule.doc.readability"],
      "标题比对读的是目录条目里的真实标题（不是恒真断言）")
check(len(catalog) > 300, f"目录条目解析到了全部条目（实测 {len(catalog)} 条）")

# 前缀非法的文档过去被整篇跳过：只要进了两份目录就绕开全部导读判据
with tempfile.TemporaryDirectory() as tmp:
    stray = os.path.join(REPO_ROOT, "doc", "notes.guard-probe.md")
    try:
        with open(stray, "w", encoding="utf-8") as fh:
            fh.write("# 探针\n\n**一句话**：前缀非法但导读齐全，用来确认闸门不会放它过去。\n"
                     "**谁该读**：验证判据的人。\n**读完能做什么**：知道前缀非法照样判红。\n")
        _, _, stray_bad = checker.scan()
        check(any("notes.guard-probe" in x for x in stray_bad),
              "前缀不在七类里的文档会被点名（不再整篇跳过）")
        probe = subprocess.run(
            [sys.executable, os.path.join(REPO_ROOT, "scripts", "doc-readability-check.py"), "--ratchet"],
            cwd=REPO_ROOT, capture_output=True, text=True)
        check(probe.returncode != 0 and "七类之外的前缀" in probe.stderr,
              "前缀非法时闸门判失败")
    finally:
        if os.path.exists(stray):
            os.remove(stray)
_, _, clean_bad = checker.scan()
check(not clean_bad, f"当前 doc/ 没有非法前缀（判据不是恒真：{clean_bad[:3]}）")

print()

check(any(".Codex" in d for d in checker.RULE_DIRS),
      "规则扫描覆盖 Codex 侧规则目录（少扫一处那一处就能绕开导读要求）")
check(any(".agents" in d for d in checker.SKILL_DIRS),
      "技能扫描覆盖 Codex 侧技能根（.agents/skills 里也有真实技能）")
skill_total, skill_missing, _ = checker.scan_skills()
# 不拿当前技能数当下界 —— 删掉一个技能不该把闸门弄红。改成断言「每个配置的
# 技能根都真的被扫到了」，扫描面才是这条守卫要守的东西。
per_root = {}
for rel_dir in checker.SKILL_DIRS:
    abs_dir = os.path.join(REPO_ROOT, rel_dir)
    if not os.path.isdir(abs_dir):
        continue
    per_root[rel_dir] = len([n for n in os.listdir(abs_dir)
                             if os.path.isfile(os.path.join(abs_dir, n, "SKILL.md"))])
check(len(per_root) == len(checker.SKILL_DIRS),
      f"配置的技能根都存在（实测 {sorted(per_root)}）")
check(all(v > 0 for v in per_root.values()), f"每个技能根都扫到了技能（{per_root}）")
check(skill_total == sum(per_root.values()),
      f"扫描总数等于两处技能根之和（{skill_total} vs {sum(per_root.values())}）")
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
