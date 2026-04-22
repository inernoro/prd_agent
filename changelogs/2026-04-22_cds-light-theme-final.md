| fix | cds | 白天主题下彻底消除暗色背景残留：--bg-terminal 在 light 从 #1f1d2b 改为 #efe7df（和 --bg-base 对齐）；self-update 进度日志、agent-key 代码块、projects.js yaml 预览、cds-clone-log 全部走 var(--bg-terminal) + var(--text-primary) 让主题自动翻转 |
| docs | rules | .claude/rules/cds-theme-tokens.md 顶部加🚨最高原则：白天主题禁止任何暗色背景 + 黑名单字面量（#0a0a0f / #0b0b10 / #1f1d2b / #e8e8ec / #cbd5e1）+ 提交前检查清单 |
| docs | cds | cds/CLAUDE.md 新增规则 0（最高优先级）把"白天禁暗底"钉死，反复踩 10+ 次的坑显式禁止 |
