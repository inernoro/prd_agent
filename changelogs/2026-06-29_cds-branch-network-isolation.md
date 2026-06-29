| feat | cds | 分支级网络隔离：每分支专属 app 网（cds-br-<id>）承载 app↔app 服务发现，共享 infra 网（cds-proj-<id>）承载 app↔infra，杜绝多分支同名服务别名（如 apigateway）在共享网上 DNS 串流 |
| feat | cds | 一个分支随便部署多少临时/实验容器都只落在自己的分支网，永远影响不到别的分支；隔离为每分支天然默认，不做项目级硬开关、不限制分支，仅留全局逃生开关 CDS_BRANCH_NETWORK_ISOLATION=0 |
