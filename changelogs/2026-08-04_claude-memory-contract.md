| fix | claude-md | 规则 frontmatter 键名 globs 改为规范要求的 paths，修复 52 条规则全部无条件加载的静默退化 |
| fix | claude-md | 修掉 4 条死 glob（enum-ripple-audit 的 Enums 目录、marketplace 的 IForkable.cs、cursor 表的 LandingPage 路径），死 glob 会让规则永不加载 |
| refactor | claude-md | 39 条规则改为按 paths 作用域加载，13 条跨切面行为规则保持常驻；常规 session 规则注入量 272KB 降至 60KB |
| refactor | claude-md | 根 CLAUDE.md 由 476 行压到 186 注入行（达标 200 行上限），删除与 harness 自动注入重复的技能表和已漂移的规则索引表，历史背景转入 HTML 注释（注入前被剥离，零 token） |
| test | claude-md | 新增 scripts/tests/test_claude_memory_contract.py 守卫：frontmatter 键名、死 glob、注入行数、导读两行、索引漂移五项断言 |
| ci | claude-md | 守卫接入 CI docs-readability job（该 job 的 path filter 含 '**'，每个 PR 必开） |
