| feat | scripts | 新增 Phase 2 冒烟测试套件 (scripts/smoke-lib.sh + smoke-health.sh + smoke-prd-agent.sh + smoke-defect-agent.sh + smoke-report-agent.sh + smoke-all.sh) —— 部署后几十秒验证 Health/鉴权 + PRD 会话 Run + 缺陷 CRUD + 周报 CRUD 链路,用 X-AI-Access-Key + X-AI-Impersonate 真实 curl 打 CDS 预览域名,每个子脚本 best-effort 清理自己的测试数据 |
| feat | ci | `.github/workflows/ci.yml` 新增 `smoke-preview` job (workflow_dispatch 手动触发),入参 smoke_host + smoke_skip,走 repo secret AI_ACCESS_KEY 鉴权;Phase 3 再挪到 /cds-deploy 完成 hook 里自动触发 |
| docs | doc | 新增 doc/guide.smoke-tests.md 说明文件清单 / 环境变量 / CI 集成 / 扩展新 Agent 的模板,作为 Phase 2 交接文档 |
