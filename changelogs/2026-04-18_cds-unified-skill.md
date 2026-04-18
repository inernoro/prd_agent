| feat | skill | 新增统一 `cds` 技能，合并 cds-project-scan + cds-deploy-pipeline + smoke-test 三个技能为单一入口 |
| feat | skill | cdscli 扩展 5 个新命令：init (env 向导) / scan (项目扫描) / smoke (分层冒烟) / help-me-check (自动诊断+根因) / deploy (完整流水线) |
| feat | skill | reference/{api,auth,scan,smoke,diagnose,drop-in}.md 6 份按需加载的进阶文档 |
| feat | cds | /api/export-skill 重构为打包整个 .claude/skills/cds/ (含 cli/ + reference/)，README 指导 drop-in 到其它项目 |
| feat | cds | 项目卡片新增「📦 下载 cds 技能包」按钮（位于 🔑 授权 Agent 左侧），一键 tar.gz 下载 |
| docs | skill | 给 cds-project-scan / cds-deploy-pipeline / smoke-test SKILL.md 顶部加废弃/合并指引，保留向后兼容触发词 |
