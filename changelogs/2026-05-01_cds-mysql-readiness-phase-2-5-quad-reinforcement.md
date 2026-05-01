| feat | cds | Phase 2.5 — 抽出 deploy 自动起 infra 决策为纯函数 `computeRequiredInfra`(services/deploy-infra-resolver.ts),便于跨项目 / stale state / Layer 1+2 综合场景单测 |
| feat | cds | 新增 cdscli `verify` 子命令:在部署前对 cds-compose.yml 跑 6 类静态检查(workDir 存在 / ports 必填 / infra image 必填 / ${VAR} 解析闭环 / schemaful DB migration / depends_on 提示 / 密码 URL 安全),三级严重度输出 + 退出码语义 |
| docs | cds | 新增 doc/spec.cds-compose-contract.md — cds-compose 完整契约 SSOT(字段表 + 7 类常见漏洞 + verify 校验规则 + 实现索引) |
| docs | cds | SKILL.md 加「7 类常见漏洞 + 自检清单」段,把 geo 实战根因黑名单化,防后续 agent 重复踩坑 |
| test | cds | 3 个新测试:tests/services/discover-infra-cross-project.test.ts(锁住 Map key 改 containerName 修复)+ tests/services/deploy-auto-infra.test.ts(Layer 1+2 决策)+ tests/services/state-vs-docker-sync.test.ts(stale state vs docker 实际状态) |
| docs | cds | plan.cds-mysql-readiness.md § 三 Phase 2.5 全部勾选 + § 五进度日志追加一行 |
