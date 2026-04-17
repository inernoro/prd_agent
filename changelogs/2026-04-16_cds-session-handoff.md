| docs | cds | 新增 `doc/design.cds-fu-02-auth-store-mongo.md` —— FU-02 MapAuthStore mongo 后端的独立设计稿:接口 / 数据模型(cds_users + cds_sessions)/ 启动时按 CDS_AUTH_BACKEND 分发 / memory→mongo 迁移策略(接受一次重登)/ 测试计划 / 回滚路径。下一棒可直接按此稿实施,不需要先设计 |
| docs | cds | 新增 `doc/report.cds-railway-alignment.md` —— 逐条对齐 Railway 范式的 7 大类 + 我们独有的 10 个护城河特性 + 完成度量化:日常可用性 92% / 按功能权重 73%。明确下一步建议 FU-02 → P5 → P6 顺序推进,不要反过来 |
| docs | cds | 新增 `doc/report.cds-handoff-2026-04-16.md` —— 本 session 完整交接报告(8 章):commit 时间线 / UF×22 GAP×16 L10N×3 FU×4 TEST×2 交付清单 / 关键文件:行号索引 / 已知限制 / 人工验收 11 步清单 / 下一棒优先级建议 / 关联文档地图 |
| docs | cds | 更新 `doc/plan.cds-roadmap.md` v1.0 → v1.2 —— 把"本次迭代"改为"已完成";Phase 0/1 全部 ✅;Phase 2 多项目 ✅ + 模板库 📋 未启动;Phase 3 🔮 未启动 |
| docs | cds | 更新 `doc/plan.cds-multi-project-phases.md` P5/P6 注记 —— P5 前置依赖明确为 FU-02(不能并行);P6 和 Phase 3 release agent 作用域边界需独立评审 |
| docs | cds | tighten `doc/guide.cds-view-parity.md` §5 smoke runbook —— 每个步骤加 "操作 · 预期 · 失败判定 · 失败回归的 UF 编号" 四栏;新增 §5.5 出错回报模板(给下一棒填空);新增 §5.6 已知未覆盖角落(iPad / Windows / 大仓库 / key 轮换) |
