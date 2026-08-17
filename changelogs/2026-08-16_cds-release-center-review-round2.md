| fix | cds | 证据表在途发布不再显示成「成功」，回滚入口只给真正成功的版本 |
| fix | cds | 回滚对话框按记录自身的环境打开，不再挂到当前选中的环境上 |
| fix | cds | 基础设施自动备份先写临时目录，校验通过才落正式文件，避免残留半份产物 |
| fix | cds | MySQL 备份不再依赖 pipefail，容器内只跑 mysqldump、压缩交给宿主分步判退出码 |
| fix | cds | 查备份历史不再顺手创建目录，「一份都没有过」重新可辨 |
| fix | cds | 全环境矩阵不再把发布进行中画成红色「失败」 |
| fix | cds | 发布控制台区分「翻旧记录」与「本次发布」，历史条目不再冒充当前会话 |
| fix | cds | 自动发布规则按请求代次丢弃切项目前的旧响应，避免删错项目的规则 |
| fix | cds | 容器内运行时监听全网卡，修复绑回环导致 docker 发布端口不可达 |
| fix | cds | 发布控制台切项目后丢弃旧响应，避免对着另一个项目的环境执行操作 |
| fix | cds | 发布控制台历史轨不再把发布进行中标成「成功」并给出回滚入口 |
| fix | cds | Redis 备份的密码支持从容器内进程命令行取，不再只读环境变量 |
| fix | cds | Redis 备份完成判据改用 INFO persistence，小库同秒完成不再误判超时 |
| fix | cds | 发布控制台所有项目级请求共用一套过期判据，分支列表不再错配 |
| fix | cds | 暴露面自检不再把 REDIS_ARGS 的存在当认证证据，裸奔的公网 Redis 不再被误降级 |
| fix | cds | 备份历史按项目限定的文件名筛选，不再列出别的项目同名服务的备份 |
| fix | cds | 恢复前快照的文件名带项目段，同名服务不再互相覆盖救命快照 |
| fix | cds | 事件驱动发布钉住触发它的 commit，紧邻的第二次 push 不再被上一个事件发出去 |
| fix | cds | 发布控制台翻看历史记录时不再宣称「已切到」，回滚按钮同步收敛到当前版本 |
| fix | cds | 全环境矩阵的「提升版本」留在本页走钉版弹窗，不再跳控制台丢掉候选 commit |
| fix | cds | 候选版本已不是分支 tip 时提升按钮禁用并给出原因，不再点了才知道发不出去 |
| fix | cds | 「回滚到此版本」真的回滚到被点的那一版，不再退到它的上一版 |
| fix | cds | 环境配置卡的发布模式改为只读并给出向导入口，不再提供必然 400 的模式切换 |
| fix | cds | 签发集群连接码时校验远端可达性，主节点绑回环而码指向裸端口时当场告警 |
| fix | cds | MySQL 备份改为容器内流式压缩，不再中转未压缩 dump，退出码仍取 mysqldump 自己的 |
| fix | cds | 备份磁盘闸改为每个目标之前复查，空间不足时剩余目标记为「未执行」而非静默少备 |
| fix | cds | 周期备份加单飞闸，上一轮未跑完不再叠加下一轮互删临时文件 |
| fix | cds | Redis 备份按 CONFIG GET 的 dir/dbfilename 取快照路径，不再写死 /data/dump.rdb |
| docs | cds | 新增基建凭据轮换 runbook，含 Mongo/MySQL 假轮换陷阱与 JWT 一值两用的安全顺序 |
| docs | cds | 债务台账记入 E16 四个预设无认证 / E17 无轮换路径 / E18 无轮换审计 |
| security | cds | redis 预设改为默认带口令（requirepass 经 env 展开，不进命令行），连接串同步带凭据 |
| fix | cds | 暴露审计拆开 sh -c 整条命令再比对，有口令的库不再被误报「无认证 critical」 |
| test | cds | 改写两条把「redis 无口令」锁死的测试，补 catalog 认证与暴露审计的跨模块接线守卫 |
| fix | cds | 手工下载 redis 备份改用带认证与完成确认的探测脚本，不再忽略 BGSAVE 失败给出陈旧快照 |
| fix | cds | redis 恢复按运行时解析的快照路径写入，不再写死 /data/dump.rdb 导致「恢复成功却加载旧数据」 |
| docs | cds | 轮换 runbook 补 MySQL app 账号与服务 env 同步、容器重建两步，修正「没有轮换路径」的表述 |
| fix | cds | MySQL 导出捕获 gzip 端退出码，并在转正前加 gzip -t 完整性校验，杜绝截断档案顶掉可用旧备份 |
| fix | cds | redis 快照路径解析在 CONFIG GET 失败时报错退出，不再猜 /data/dump.rdb |
| fix | cds | 每次备份导出套 ulimit 写入上限，单个大库不再能把宿主根盘写满 |
| docs | cds | 轮换 runbook 修正 PostgreSQL 账号（app 非 postgres），并补九个预设的账号真值表 |
