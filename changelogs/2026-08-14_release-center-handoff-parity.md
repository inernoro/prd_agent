| feat | cds | 发布中心按设计稿 design_handoff_release_center 重构环境与配置 / 健康监测 / 证据归档三个分区，元素逐条对齐 |
| feat | cds | 发布中心分区映射到 `?section=fleet\|config\|rules\|health\|evidence`，一条链接就能分享当前那一屏 |
| fix | cds | 证据归档恢复被误删的步骤条与配置变更历史（后端仍在供数，前端此前无人渲染） |
| test | cds | 新增 release-center-handoff-parity 守卫，逐条核对设计稿点名的元素，少一个即红 |
