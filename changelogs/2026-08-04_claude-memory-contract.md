| fix | claude-md | 规则 frontmatter 键名 globs 改为规范要求的 paths，修复 52 条规则全部无条件加载的静默退化 |
| fix | claude-md | 修掉 4 条死 glob（enum-ripple-audit 的 Enums 目录、marketplace 的 IForkable.cs、cursor 表的 LandingPage 路径），死 glob 会让规则永不加载 |
| refactor | claude-md | 39 条规则改为按 paths 作用域加载，13 条跨切面行为规则保持常驻；常规 session 规则注入量 272KB 降至 60KB |
| refactor | claude-md | 根 CLAUDE.md 由 476 行压到 186 注入行（达标 200 行上限），删除与 harness 自动注入重复的技能表和已漂移的规则索引表，历史背景转入 HTML 注释（注入前被剥离，零 token） |
| test | claude-md | 新增 scripts/tests/test_claude_memory_contract.py 守卫：frontmatter 键名、死 glob、注入行数、导读两行、索引漂移五项断言 |
| ci | claude-md | 守卫接入 CI docs-readability job（该 job 的 path filter 含 '**'，每个 PR 必开） |
| fix | claude-md | llmgw 模块只有 AGENTS.md 没有 CLAUDE.md，Claude Code 读不到它的必跑校验命令；按规范补 llmgw/CLAUDE.md 走 @AGENTS.md 导入 |
| fix | claude-md | 根 CLAUDE.md 补上此前完全缺失的 llmgw 模块（模块列表 / pnpm 范围 / changelog 范围三处） |
| test | claude-md | 守卫增加模块覆盖三项断言：有 AGENTS.md 必须有 CLAUDE.md、必须走 @import 而非复制、模块必须在根 CLAUDE.md 露出 |
| refactor | claude-md | 根 AGENTS.md 与 CLAUDE.md 合二为一：AGENTS.md 改为工具中立的共用 SSOT（483 行压到 205 行），CLAUDE.md 改为 @AGENTS.md 导入 + 宿主专属差异（9 行），消灭两份 95% 相同的手工副本 |
| fix | claude-md | 守卫的行数预算改为解析 @import 后再计量，否则导入模式会让预算检查变成假绿灯 |
| test | claude-md | 守卫新增断言：根有 AGENTS.md 时 CLAUDE.md 必须 @import 而非复制；模块覆盖与索引检查改看解析后文本 |
| fix | claude-md | 修复裁剪 AGENTS.md 索引表打断 Codex 规则发现路径导致 GatewayDataDomainGuardTests 变红；改为显式点名 .Codex/rules 两条并说明触发范围 |
| fix | claude-md | 按 Codex 评审补齐 4 条过窄的 paths：production-release-safety 补 fast.sh 与整个 deploy/nginx、config-runtime-drift 补 appsettings 与 .env、enum-ripple-audit 补 pages/lib 下的常量注册表、onboarding-tips 补带教程的产品页 |
| test | claude-md | 守卫新增断言：.Codex/rules 每条必须在 AGENTS.md 被点名，且更长的同名路径不算数（Codex 无按需加载，未点名等于永不加载） |
| fix | claude-md | Codex 第二轮评审：quickstart-zero-friction 补 quick*.sh、ai-model-visibility 补 prd-desktop、full-height-layout 补 prd-admin/src/layouts |
| refactor | claude-md | sync-cursor-rules.sh 的 glob 改为 globs:auto 从源规则 paths 派生，消灭「同一份作用域信息手工维护两份」的漂移类；派生时当场暴露并修正 cds-first-verification 两侧定性不一致 |
| test | claude-md | 守卫新增断言：cursor 同步表禁止硬编码 glob，必须走 globs:auto |
| fix | claude-md | Codex 第三轮：snapshot-fallback 补 Models（快照实体本体就在那）、codebase-snapshot 补 doc/、report-design-system 补报告发布器 py |
| refactor | claude-md | predicate-and-wiring-discipline 由路径作用域改回无条件常驻——它的触发是「任何新增判定/模块/测试」，枚举下去等于全仓，常驻更诚实（常驻预算 60KB→74KB） |
| fix | claude-md | 恢复被重写误删的 AGENTS.md §5.5「Review 范围熔断」——CHANGELOG 记录它是生效规则，删掉等于重新放开机器评论驱动的无界扩张 |
| fix | claude-md | 守卫的 cursor 检查名不副实：只验映射写了 globs:auto，不验镜像是否真的重新生成过；改为重新生成到临时目录逐字比对 |
| docs | claude-md | 新增 doc/debt.platform.agent-rule-scope.md 记录三条 B 类作用域缺口，按 §5.5 分类不在本 PR 展开 |
| test | claude-md | 守卫新增条款完整性断言：AGENTS.md 的 17 条编号条款不得在重写中静默消失，删除必须显式改 REQUIRED_CLAUSES 并说明理由 |
| docs | claude-md | Codex 第五轮三条 B 类作用域缺口（导航登记漏后端菜单目录、移动端密度漏样式 token、CDS 主题漏 Tailwind 配置）记入 debt 台账 |
| fix | claude-md | AGENTS.md 规则发现指令指向一个被同次重写删掉的清单；改为写清扫描步骤（ls 规则目录 + 读导读两行选取），不再维护会漂移的第二份索引 |
| docs | claude-md | Codex 第七轮 B 类记账：server-authority 漏网关 C# 表面；台账补记「网关剥离后没人回头拓宽既有规则作用域」这条跨条目规律 |
