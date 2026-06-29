| feat | cds | 分支级网络隔离：每分支专属 app 网（cds-br-<id>）承载 app↔app 服务发现，共享 infra 网（cds-proj-<id>）承载 app↔infra，杜绝多分支同名服务别名（如 apigateway）在共享网上 DNS 串流 |
| feat | cds | 一个分支随便部署多少临时/实验容器都只落在自己的分支网，永远影响不到别的分支；隔离为每分支天然默认，不做项目级硬开关、不限制分支，仅留全局逃生开关 CDS_BRANCH_NETWORK_ISOLATION=0 |
| fix | cds | 隔离启动时序（Codex P1）：app 容器改用 create→connect(infra)→start，infra 共享网在进程启动前就连上，避免 entrypoint 阶段就开 DB 连接的镜像（极速版/API）在 infra 网就位前连库失败 |
| fix | cds | 远端执行器分支网清理（Bugbot Medium）：cds-br-* 网创建在执行器 docker host，删分支时执行器 /exec/delete 顺手 removeBranchNetwork，避免隔离网在 worker 节点随删分支不断堆积 |
| fix | cds | 超长分支网名保唯一（Codex P2）：branchAppNetworkName 超 60 字符时截断并追加完整 id 的短哈希，避免两个共享前 60 安全字符的分支 id 撞同一张 cds-br-* 网而重新引入跨分支 DNS 串流；≤60 的常规 id 输出零回归 |
| fix | cds | 陈旧别名清理扫对网（Bugbot Medium）：隔离后 app 的 --network-alias 落在分支网而非共享项目网，pruneStaleAppContainersForProfile 改扫 netPlan.runNetwork（隔离=分支网），否则失败/半成功重部署后分支网上残留同别名僵尸端点、DNS 轮询复发 |
| fix | cds | 分支网名截断阈值算上前缀（Codex P2 二修）：返回名 = "cds-br-"(7)+safe，docker DNS label 上限 63，故 safe 阈值取 56 而非 60，否则 57~60 字符的分支 id 产出 64~67 字符网名超限 |
| fix | cds | 共享 infra 网连接失败不再静默吞（Bugbot Medium「Infra connect failure ignored silently」）：connectContainerToSharedNetwork 原把 `no such container` 当成功返回，但唯一调用方是 create→connect→start 时序、容器在连接前刚 `docker create` 成功，故该错误是真异常而非并发 race；吞掉会让后续 docker start 把 app 只挂分支网、连不上共享 mysql/redis（DB/redis DNS 失败却 deploy 报成功）；现一律 record + throw，部署显式失败 |
