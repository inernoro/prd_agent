| docs | doc | 新增 doc/report.cds-shared-service-mvp-runthrough.md：本机零污染端到端 MVP 演示报告（注入 deployment 绕过 SSH，验证协议契约 + sidecar 真流式 LLM 调用，输出"柳絮轻飘，花开满径。"）
| feat | cds | 新增 cds/scripts/mvp-demo.ts：tsx 跑的一次性脚本，临时 state.json + mini express + 直连 sidecar 端到端验证；隔离设计（mkdtemp + 9991 端口避开正式 9900），跑完自动清理；不进 npm scripts 不进 server.ts，零侵入
