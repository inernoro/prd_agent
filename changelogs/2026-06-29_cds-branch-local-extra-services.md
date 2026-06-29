| feat | cds | 分支级临时额外服务：分支可在项目底座之上自助声明额外服务/容器（PUT /branches/:id/extra-services），只在本分支部署、跑分支专属网、不进项目、不需全局审批、删分支即消失、不影响别的分支 |
| feat | cds | 部署与资源/拓扑展示统一走 getEffectiveProfilesForBranch（项目 profiles + 分支 extraProfiles 合并）；纯增量可选，未声明额外服务的分支老行为零回归 |
| feat | cds | 分支删除收尾清理分支专属网（removeBranchNetwork），让「删分支即消失」覆盖到网络层 |
| feat | cds | 分支额外服务接入全部部署/重部署/db-init/端口/env 预览/主分支部署/孤儿剪枝/列表与拓扑展示路径(首版只接了 executor payload),声明的额外服务真正起容器、不被孤儿剪枝误删 |
| feat | cds | PUT /branches/:id/extra-services 支持 ?redeploy=1：声明额外服务后一步触发真正重部署,补上「声明即生效」(纯配置变更不会自动重建已运行分支的痛点) |
| fix | cds | 部署对称收尾：服务从期望清单移除(额外服务被清/项目 profile 被删)时,部署会真正拆掉它的容器并删条目(此前只对 error 态打 warning、容器残留),让分支额外服务「加能起、删能下」对称 |
