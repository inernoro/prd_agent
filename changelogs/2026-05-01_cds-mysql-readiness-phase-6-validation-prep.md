| feat | cds | Phase 6 准备 — 新增 tests/integration/phase6-yaml-contract.smoke.test.ts:把 cdscli scan(Python)输出喂给 CDS parseCdsCompose(TS)做契约测试,合成 Prisma+MySQL + 普通 Node 两场景验证 Phase 1-5 全链路字段被正确解析 |
| fix | cds | Phase 6 契约测试发现真 bug:cdscli 给 mysql infra 加 `./init.sql:/docker-entrypoint-initdb.d/...` 单文件挂载,被 hasRelativeVolumeMount 误判为 app source 挂载,导致 mysql 被错分类为 app。修 compose-parser.ts:isAppSourceMount 排除 INIT_SCRIPT_TARGET_PREFIXES + CONFIG_FILE_EXT_RE 类挂载 |
| docs | cds | 新增 doc/guide.cds-mysql-validation-runbook.md(Phase 6 真人实战 runbook):候选项目 5 个 + 推荐评分 + Step 1-7 操作清单 + 完成判定 + 已知风险表 + 失败回填流程 + 接力 AI 启动模板 |
| docs | cds | plan.cds-mysql-readiness.md § 五 Phase 6 加 ✅ 准备阶段(代码 + 文档 done,真实 repo 验收待用户挑选) |
