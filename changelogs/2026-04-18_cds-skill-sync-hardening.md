| fix | skill | 触发词收紧 — 维护者同步工作流只认 "/cds-sync" / "帮我同步 cds 技能" 等带 cds 关键字的显式指令，禁止"同步技能"/"更新技能"泛指令误触发 |
| feat | skill | cdscli sync-from-cds 路径可配置：--routes-dir 参数 + $CDS_ROUTES_DIR env + git root 推断 + cli 相对路径兜底，四级降级应对 CDS 未来独立仓库场景 |
| feat | skill | sync-from-cds 输出加 routesDir / scannedFiles 字段 + stderr 打印扫描路径，杜绝"扫到哪去了"的不透明情况；--quiet 抑制 stderr |
| docs | skill | maintainer.md 说明 CDS 独立仓库后的路径配置方式（CDS_ROUTES_DIR 环境变量）|
