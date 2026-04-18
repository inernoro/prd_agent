| feat | cds | `build_ts` 改用 git HEAD SHA 作为编译缓存 sentinel（替代易误判的 mtime 比较），修复 self-update 后 dist/ 不重建导致新代码不生效的 pre-existing bug |
| feat | skill | 新增 `.claude/skills/cds-deploy-pipeline/cli/cdscli.py` Python CLI 封装 CDS REST API，解决 curl+bash 方案的嵌套 JSON 转义、UA 被 Cloudflare ban、SSE 解析三大痛点 |
| docs | skill | cds-deploy-pipeline SKILL.md 顶部插入 cdscli 首选工具章节，命令清单取代大段 curl 示例 |
