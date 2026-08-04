| fix | claude-md | entropy-cleanup 的 D4 维仍在查已删除的 CLAUDE.md 技能表，会把 57 个技能全判成缺失并把表格行追加回 CLAUDE.md——等于自动撤销记忆文件精简；改为查 SKILL.md frontmatter 完整性 |
| fix | claude-md | create-skill-file 的 Step 6「注册到 CLAUDE.md」指向已删除的表；改为「确认 frontmatter 完整」，并同步评分表与 structure-guide |
| fix | claude-md | AGENTS.md 补技能发现步骤：只认 .agents/skills 的宿主看不到 .claude/skills 下的 57 个技能，此前依赖「宿主自动注入」的说法对这类宿主不成立 |
| docs | claude-md | guide.skill.removal-checklist 里「删 CLAUDE.md 技能表行」一项标注作废 |
| fix | prd-api | 重新生成 official-skills.generated.json：改了 create-skill-file 却没重跑打包脚本，分发包里还是旧内容，Server Build & Test 的新鲜度自测因此变红 |
