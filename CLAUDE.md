@AGENTS.md

<!--
正文在 AGENTS.md，本文件只做导入 + Claude Code 专属差异。
原因：两个根文件曾经是 95% 相同的手工副本且没有同步脚本，必然漂移——AGENTS.md 知道
llmgw 模块，CLAUDE.md 一个字都没提，导致 llmgw 的必跑校验命令对 Claude 完全不可见。
规范给「已有 AGENTS.md 的仓库」开的方子就是 @import：两边同源，不可能再分叉。
不用符号链接：Windows 建符号链接要管理员权限，且链接容不下下面这段专属差异。
新增共用规则写进 AGENTS.md，不要写在这里。
守卫：scripts/tests/test_claude_memory_contract.py
-->

## Claude Code 专属

- **规则按需加载**：`.claude/rules/` 的 frontmatter 用 `paths:`（不是 `globs:`——那个键不被识别，会退化成每 session 全量加载）。38 条按 `paths` 命中当前文件时才载入，16 条跨切面行为规则常驻。新增规则时 glob 必须命中真实文件，死 glob 会让规则永不加载。
- **技能**：`.claude/skills/`，名称与描述由 harness 自动注入，不要在记忆文件里重复维护清单。
- **记忆契约自检**：`python3 scripts/tests/test_claude_memory_contract.py`（CI `docs-readability` job 每个 PR 必跑）。
