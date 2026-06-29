| fix | cds | 极速版分支等待 CI 镜像期间预览页显示「预览环境准备中 · 极速版正在拉取分支」自动刷新等待页，不再误导为「分支当前未运行 · 请手动重新部署」 |
| fix | cds | waiting-status 接口对 ciImageStatus=waiting 分支返回 loading=true，避免等待页每 6 秒自刷新跳到诊断页 |
| feat | cds | CI 预构建镜像构建失败（ciImageStatus=failed）时预览页给出「极速版镜像未就绪」专属归因，替代泛化未运行文案 |
