| feat | cds | 分支级临时额外服务：分支可在项目底座之上自助声明额外服务/容器（PUT /branches/:id/extra-services），只在本分支部署、跑分支专属网、不进项目、不需全局审批、删分支即消失、不影响别的分支 |
| feat | cds | 部署与资源/拓扑展示统一走 getEffectiveProfilesForBranch（项目 profiles + 分支 extraProfiles 合并）；纯增量可选，未声明额外服务的分支老行为零回归 |
| feat | cds | 分支删除收尾清理分支专属网（removeBranchNetwork），让「删分支即消失」覆盖到网络层 |
| feat | cds | 分支额外服务接入全部部署/重部署/db-init/端口/env 预览/主分支部署/孤儿剪枝/列表与拓扑展示路径(首版只接了 executor payload),声明的额外服务真正起容器、不被孤儿剪枝误删 |
| feat | cds | PUT /branches/:id/extra-services 支持 ?redeploy=1：声明额外服务后一步触发真正重部署,补上「声明即生效」(纯配置变更不会自动重建已运行分支的痛点) |
| fix | cds | 部署对称收尾：服务从期望清单移除(额外服务被清/项目 profile 被删)时,部署会真正拆掉它的容器并删条目(此前只对 error 态打 warning、容器残留),让分支额外服务「加能起、删能下」对称 |
| fix | cds | 孤儿服务移除补操作租约校验（Bugbot Medium）：deploy-finalize 拆孤儿服务的循环在 containerService.remove 前后各 assertBranchOperationCurrent，租约被更高优先级操作取代时中止，杜绝在已取消的 deploy 下删 entry.services + save |
| fix | cds | 远端执行器 redeploy 收敛期望清单（Codex P2）：/exec/deploy 对 payload profiles 里没有的 service 主动下掉容器+删条目，否则 redeploy=1 清掉额外服务后 worker 上旧分支本地容器仍在跑(此前只有 master 侧 deploy 做了孤儿清理) |
| fix | cds | PUT extra-services?redeploy=1 不再谎报已触发（Bugbot Medium）：await 自调 deploy 的 HTTP 接受结果再定 redeployTriggered，被拒(暂停423/缺必填环境412/in-flight冲突409)时回 false + redeployRejected{status,message} + hint「未成功」，接受后后台 drain SSE、构建服务端异步继续 |
| fix | cds | 清空最后一个额外服务后残留容器（Codex P2）：deploy 期望清单为空但仍有在跑服务时，不再直接 400 跑路，而是 fencing-safe 拆掉残留服务容器+删条目(本地就地拆；远端 owned 放行到 /exec/deploy 收敛空 payload)；env 必填闸门在 profiles 为空时跳过 |
| fix | cds | 执行器空清单收敛标 idle 而非 error（Bugbot/Codex P2）：/exec/deploy 孤儿清理把服务全删后 entry.services 为空，原状态计算落到 error，心跳同步把一次成功清空误标失败；改为无服务=idle（与 master 空清单清理一致），complete 文案区分「已清空所有服务」 |
| fix | cds | extra-services PUT 剥离 env 掩码哨兵（Bugbot Medium）：GET→编辑→PUT 往返带回 ***[masked]*** 等哨兵时，按同 id 旧值回填、无旧值则丢弃，杜绝把字面哨兵当密钥持久化进容器 env |
| fix | cds | container-exec 掩码用分支有效 profiles 查 env（Codex P2）：原用项目级 getBuildProfile 查不到分支额外服务的敏感 env，导致 echo $TOKEN 吐明文；改用 getEffectiveProfilesForBranch（项目+额外）查，额外服务密钥同样被值替换掩码 |
| security | cds | GET/PUT /branches/:id/extra-services 补 assertProjectAccess 项目级访问控制(Bugbot High)：此前缺校验，项目 A 的 cdsp_ key 可读取/改动项目 B 分支的额外服务并触发跨项目重部署；现与其他分支路由一致，跨项目返回 403 project_mismatch |
