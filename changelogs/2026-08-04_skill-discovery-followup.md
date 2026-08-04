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
| fix | claude-md | entropy-cleanup 的 PR 正文模板「改动 diff」只列文档索引与 changelog，漏掉 D4 会修改的 SKILL.md；补两个技能根的条件条目、「需人工处理」小节，并修正 changelog 碎片的模块列 |
| fix | claude-md | D4 的字段判据未限定在 frontmatter 块内，正文出现 name: 示例行会把缺字段的技能误判成合规；改用 awk 取 frontmatter 块 |
| fix | claude-md | 新增 Step 4.5 硬闸：D4 里无法自动修复的三类条目命中时跳过自动 squash 合并，只写进 PR 正文等于随 PR 一起被合并掉 |
| fix | claude-md | 上一轮加的 D4 合并硬闸读 $D4_SCAN_OUTPUT，而该变量从未被赋值，真实运行时恒为空、闸门永不触发；改为闸门自己重跑判据，不依赖任何外部变量 |
| feat | doc-tooling | doc-readability-check.py 新增 --skills-audit 模式，复用 check_skill 输出可发现性判定，并补上「目录没有 SKILL.md」这个既有缺口 |
| refactor | claude-md | entropy-cleanup 的 D4 扫描/修复/合并闸三处不再自己写 frontmatter 判据，统一调用 --skills-audit；判据两处实现是前七轮偏差的共同根因 |
| fix | claude-md | Step 6.2 无条件合并同名旧 PR，会把被硬闸挡下的 [需人工] PR 一并合掉，使硬闸只延迟一轮；改为跳过并对其余 PR 合并前复跑审计 |
| fix | claude-md | Step 6.2 的「合并前复跑审计」跑在当前 checkout 上，而要合的是另一个 PR 的 head，等于用不相干的证据放行；移除该步的旧 PR 自动合并，恢复条件记入 debt |
| fix | claude-md | D4 自动修复会改分发技能的源却不重生成分发包，定时熵减会重现「分发旧内容 + 新鲜度自测变红」；修复路径补重生成与自测，git add 补生成物路径 |
| fix | claude-md | 可移植自查块用 <skill-dir> 占位，bash 当成重定向导致语法错误，外部用户复制即报错；改为 skill_dir 变量并加引号 |
| fix | doc-tooling | --skills-audit 对「声明的技能根整个不存在」是 continue 跳过，删光一个宿主的技能仍判干净；改为 BLOCK + 非零退出 |
| fix | claude-md | PR 工作流摘要仍写「有同类 PR 先合并再创建」，与 6.2 新规矛盾，照摘要执行会绕过刚移除的不安全合并 |
| fix | claude-md | D4 判据收敛到 --skills-audit 后输出词表变成 AUTOFIX_NAME / BLOCK，但硬闸说明与 PR 模板仍匹配自造的 MISSING_SKILL_*，导致缺技能根、坏 YAML 等多数阻塞情形下「需人工处理」小节被判为不需要而删掉，留下无线索的 [需人工] PR；改为按 BLOCK 判定并逐条照抄审计原因 |
| fix | claude-md | 6.4 合并前的追加行白名单漏了 official-skills.generated.json，而 Step 3 会重新生成、Step 5 会提交它，等于自动审计必然拒绝自己产出的合法 PR；补进白名单与 PR 模板，并限定「本轮没改技能却出现它按越界处理」 |
