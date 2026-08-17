| security | cds | 基础设施数据端口默认仅绑定私网并拒绝公网发布绕过 |
| security | cds | MongoDB、PostgreSQL、MySQL 与 Redis 新建实例强制启用认证 |
| ops | cds | 自动备份增加 R2 上传、大小与 checksum 回读校验及新鲜度健康检查 |
| security | cds | 运维事件外发为逐条校验的离机审计对象，审批状态支持重启恢复 |
| security | cds | 新增可恢复的跨平台密钥轮换技能与标准输入写密能力 |
| test | cds | 增加端口、认证、动态域名、离机备份、审计与审批恢复回归测试 |
| security | cds | 新增双栈全端口外部扫描并严格校验公开端口白名单 |
| ops | cds | 将宿主双栈外部扫描纳入每日健康检查并对未知结果从严告警 |
| security | cds | 每日从独立运行器分别核验 CDS 与正式环境公网端口白名单 |
| security | prd-api | 首次建库和用户初始化改用部署注入强凭据并移除固定邀请码 |
| security | prd-admin | 移除默认管理员口令提示并展示实际初始化账号 |
| security | prd-api | 用户整库重新初始化默认关闭并移除管理端常规入口 |
| security | prd-api | 用户改密、角色状态变更与重新初始化持久记录操作者身份 |
| security | cds | 防火墙自检同时核验 nft 与 legacy 运行后端并对未知状态从严告警 |
| security | skill | 密钥轮换台账区分已完成与有证据的风险边界豁免，阻止无关凭据盲目轮换 |
| security | cds | 基础设施认证门禁前置到复用与唤醒之前，避免既有容器绕过启动协议 |
| security | platform | MAP、CDS、模型网关与桌面端的自有入口改为部署时注入 |
| test | platform | 动态域名守卫扩展到前端、桌面端与网关运行时源码 |
| security | cds | 离机备份下载增加流式大小与 sha256 双校验并原子落盘 |
| test | cds | 增加无端口临时 Mongo 的 R2 备份真实恢复演练入口 |
| security | cds | 认证门禁与暴露审计按运行态服务元数据识别不透明数据库镜像 |
| security | cds | 将认证门禁与运行态暴露审计扩展到目录内全部有状态服务 |
