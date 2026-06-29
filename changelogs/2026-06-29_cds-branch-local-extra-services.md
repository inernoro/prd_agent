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
| fix | cds | extra-services PUT env 改为 merge 不 replace（Bugbot High）：入参省略 env 不再丢失已存密钥、部分 env 不再删未提及的旧 key（以同 id 旧 profile env 为基底叠加，与 build-profiles PUT 口径一致），叠加掩码哨兵剥离 |
| security | cds | extra-services 响应给 env 脱敏（Codex P1）：GET/PUT extra-services + 分支详情/列表/SSE 快照序列化 extraProfiles 时对敏感 env 值打掩码（***），状态层保持明文供 deploy 直读；杜绝任何可查看分支的调用方拿到额外服务原始密钥 |
| fix | cds | 远端清空收敛 master 服务表（Bugbot Medium）：远端 owned 分支空清单部署后，executor complete 的 services 是权威集合，master 不再只 patch deployedMode，而是按其删除本地已不存在的服务条目，杜绝清空后 UI 残留 ghost 服务到下次心跳 |
| security | cds | 分支列表 SSE 流式事件也给 extra env 脱敏（Bugbot/Codex P1）：branchForView 此前只作用于初始 snapshot，后续 branch.status/branch.updated 经 exposeBranchForStream 取原始 branch 泄露额外服务明文密钥；现 exposeBranchForStream 统一过 branchForView |
| security | cds | profile-overrides 面板给额外服务 env 脱敏（Codex P1）：切到 getEffectiveProfilesForBranch 后额外服务进了 override 面板，baseline/effective.env 原样返回会泄露分支本地密钥；现仅对额外服务 maskSecrets（项目 profile 行为不变） |
| security | cds | 修复 deploy 宿主机命令注入（Codex P1）：dockerImage/command 来自用户可控 BuildProfile（含分支额外服务），runService 拼 docker create/run 时镜像未引用、command 在宿主机双引号内（$()/反引号会在 CDS 宿主机执行）；现 container.ts 对镜像与 command 走 shellQuote 单引号（容器内 sh -c 仍正常解释运算符），extra-services PUT 另加严格镜像引用校验作边界防御 |
| fix | cds | 远端 complete 后对 entry.services 做完整对账（Bugbot Medium x3）：按 executor 权威 svcMap 一次性 patch 存活服务 status/deployedMode + upsert executor-only 新服务 + prune master-only 残留 + 重算分支态（无服务=idle、有 running=running、否则 error）；修复 building 滞留、ghost 残留、以及 running 但 services 不全（漏 upsert）三类要等下次心跳才收敛的滞后 |
| security | cds | GET/PUT /branches/:id/extra-services 补 assertProjectAccess 项目级访问控制(Bugbot High)：此前缺校验，项目 A 的 cdsp_ key 可读取/改动项目 B 分支的额外服务并触发跨项目重部署；现与其他分支路由一致，跨项目返回 403 project_mismatch |
| security | cds | 修复 deploy 宿主机命令注入第二处——挂载路径与一次性命令路径（Codex P1「Validate extra-service workDir」）：workDir/containerWorkDir 经 path.join 进 `-v "src":"dst"` 与 `-w`，旧双引号写法下 workDir 含双引号+$()/反引号可在 CDS 宿主机越权执行；现 buildProfileVolumeFlags 的 -v 挂载（含 node_modules/cacheMounts）与两条 runCmd 的 -w 全部走 shellQuote 单引号，runProfileCommand 一次性命令路径的 dockerImage/command 同步补 shellQuote（此前仍是裸拼+双引号）；extra-services PUT 另加 workDir 严格白名单（相对路径、禁 .. 穿越与 shell 元字符）作边界防御 |
