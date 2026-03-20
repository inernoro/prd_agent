| feat | cds | 容器包缓存按项目隔离，路径 /data/cds/{project-slug}/cache/，多项目互不干扰 |
| fix | cds | 修复已有 buildProfile 缺少 cacheMounts 导致每次 restore 全量下载的问题 |
| feat | cds | 部署流水线技能新增 CDS 自更新场景（场景 8），cds/ 代码变更自动触发 self-update |
| fix | cds | pnpm 缓存挂载到正确路径 /pnpm/store（与 npm_config_store_dir 一致） |
| perf | cds | 容器日志查看从 3 秒轮询改为 SSE 实时流推送（GET /container-logs-stream） |
