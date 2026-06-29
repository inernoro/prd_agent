| feat | cds | 分支级网络隔离：每分支专属 app 网（cds-br-<id>）承载 app↔app 服务发现，共享 infra 网（cds-proj-<id>）承载 app↔infra，杜绝多分支同名服务别名（如 apigateway）在共享网上 DNS 串流 |
| feat | cds | 一个分支随便部署多少临时/实验容器都只落在自己的分支网，永远影响不到别的分支；隔离为每分支天然默认，不做项目级硬开关、不限制分支，仅留全局逃生开关 CDS_BRANCH_NETWORK_ISOLATION=0 |
| fix | cds | 隔离启动时序（Codex P1）：app 容器改用 create→connect(infra)→start，infra 共享网在进程启动前就连上，避免 entrypoint 阶段就开 DB 连接的镜像（极速版/API）在 infra 网就位前连库失败 |
| fix | cds | 远端执行器分支网清理（Bugbot Medium）：cds-br-* 网创建在执行器 docker host，删分支时执行器 /exec/delete 顺手 removeBranchNetwork，避免隔离网在 worker 节点随删分支不断堆积 |
| fix | cds | 超长分支网名保唯一（Codex P2）：branchAppNetworkName 超 60 字符时截断并追加完整 id 的短哈希，避免两个共享前 60 安全字符的分支 id 撞同一张 cds-br-* 网而重新引入跨分支 DNS 串流；≤60 的常规 id 输出零回归 |
| fix | cds | 陈旧别名清理扫对网（Bugbot Medium）：隔离后 app 的 --network-alias 落在分支网而非共享项目网，pruneStaleAppContainersForProfile 改扫 netPlan.runNetwork（隔离=分支网），否则失败/半成功重部署后分支网上残留同别名僵尸端点、DNS 轮询复发 |
