| fix | claude-md | entropy-cleanup 的 D4 维仍在查已删除的 CLAUDE.md 技能表，会把 57 个技能全判成缺失并把表格行追加回 CLAUDE.md——等于自动撤销记忆文件精简；改为查 SKILL.md frontmatter 完整性 |
| fix | claude-md | create-skill-file 的 Step 6「注册到 CLAUDE.md」指向已删除的表；改为「确认 frontmatter 完整」，并同步评分表与 structure-guide |
| fix | claude-md | AGENTS.md 补技能发现步骤：只认 .agents/skills 的宿主看不到 .claude/skills 下的 57 个技能，此前依赖「宿主自动注入」的说法对这类宿主不成立 |
| docs | claude-md | guide.skill.removal-checklist 里「删 CLAUDE.md 技能表行」一项标注作废 |
| fix | prd-api | 重新生成 official-skills.generated.json：改了 create-skill-file 却没重跑打包脚本，分发包里还是旧内容，Server Build & Test 的新鲜度自测因此变红 |
| fix | claude-md | entropy-cleanup 新 D4 只扫了 .claude/skills 一个技能根，且误把 doc-readability 棘轮当成「缺 SKILL.md」的兜底（它遇到缺文件的目录是跳过的）；改为两个根都扫、缺失自查 |
| fix | claude-md | entropy-cleanup 的 PR 正文模板与自查清单仍按旧的双向 D4 写，与改后的单向指标不一致 |
| fix | claude-md | entropy-cleanup 的 D4 扫了 .agents/skills 却没把该根加进 diff 核验与 git add，修了也提交不出去 |
| fix | claude-md | create-skill-file 的自查指向 prd_agent 专属脚本，而该技能会被分发到其它仓库；改为可移植自查，仓库专属闸门降为注释里的补充 |
| fix | claude-md | 上一轮把 D4 的修复动作删成了两行注释，导致只检测不修复、第二次运行仍报同笔债；补真实修复路径：name 可由目录名确定性推导故自动补，description 与整份 SKILL.md 不可安全重建故升级人工 |
