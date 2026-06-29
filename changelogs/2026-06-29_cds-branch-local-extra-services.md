| feat | cds | 分支级临时额外服务：分支可在项目底座之上自助声明额外服务/容器（PUT /branches/:id/extra-services），只在本分支部署、跑分支专属网、不进项目、不需全局审批、删分支即消失、不影响别的分支 |
| feat | cds | 部署与资源/拓扑展示统一走 getEffectiveProfilesForBranch（项目 profiles + 分支 extraProfiles 合并）；纯增量可选，未声明额外服务的分支老行为零回归 |
| feat | cds | 分支删除收尾清理分支专属网（removeBranchNetwork），让「删分支即消失」覆盖到网络层 |
