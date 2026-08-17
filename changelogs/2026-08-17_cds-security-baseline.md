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
| security | cds | R2 备份错误保留结构化服务端原因并补齐双栈来源轮换门禁 |
| security | cds | 基础设施列表脱敏启动参数凭据并按 Docker 真实命令识别认证 |
| fix | cds | 按 MySQL 实际 root 或应用账号组合判断认证状态，避免随机 root 配置被误报 |
| security | cds | 移除交付源码、脚本、文档和演示中的固定部署域名并增加仓库守卫 |
| security | cds | 项目级与受限全局 Agent Key 的读写路由统一执行项目作用域校验 |
| fix | cds | MySQL 新建门禁要求有效 root 初始化凭据，禁止仅应用账号的不可启动配置 |
| fix | prd-desktop | 动态 API 地址读取兼容稳定版 Rust 编译器 |
| fix | prd-api | 开发启动透传管理员凭据并统一 CDS 修复命令的地址变量合同 |
| fix | cds | 管理员凭据支持二选一必填组并由部署环境动态注入稳定冒烟允许地址 |
| fix | cds | 离机校验成功后才保留正式备份并按 Docker 运行态判断基础设施健康 |
| fix | cds | Legacy 数据库创建统一走随机凭据目录且启动失败不再伪装成功 |
| fix | llmgw | 由正式部署显式注入 MAP 返回入口 |
| fix | cds | 防止技能包回源递归并由运行时连接下发 MAP 地址 |
| fix | prd-desktop | 统一桌面发布入口的 API 地址门禁 |
| fix | platform | 正式发布入口与网关返回地址统一改为部署时动态注入 |
| security | cds | 备份健康状态要求覆盖全部运行中数据服务且 MySQL 使用可复用备份凭据 |
| security | cds | 正式环境与 CDS 均执行每日 IPv6 公网端口扫描 |
| fix | cds | 暴露审计的启动参数分词保留引号语义，避免带口令的 Redis 被误判为无认证 |
| ops | cds | 外部端口巡检目标缺失时输出可执行的处置指引与债务索引 |
| fix | cds | IPv6 巡检先自检观测点出网能力，区分「没扫成」与「扫了没发现」 |
| test | cds | 守住 IPv6 观测点自检顺序与证据上传闸，防止静默回退 |
