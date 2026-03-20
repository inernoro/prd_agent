| feat | cds | 容器包缓存按项目隔离，路径 /data/cds/{project-slug}/cache/，多项目互不干扰 |
| fix | cds | 修复已有 buildProfile 缺少 cacheMounts 导致每次 restore 全量下载的问题 |
| feat | cds | 部署流水线技能新增 CDS 自更新场景（场景 8），cds/ 代码变更自动触发 self-update |
