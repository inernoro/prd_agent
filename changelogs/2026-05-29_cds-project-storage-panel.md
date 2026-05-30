| feat | cds | [项目设置 → 存储] 新增项目存储面板(feature-emerge 第二波 E7):展示该项目每个 docker named volume 大小/挂载关系/类型,后端 GET /api/projects/:id/storage 解析 docker system df -v 输出,前端 ProjectStorageTab 带刷新按钮 + 空状态引导 |
| feat | cds | 新增 volume-size 服务(parseDockerSystemDf 解析 + formatBytes 格式化),15 例单测覆盖大小单位/边界/空输出 |
