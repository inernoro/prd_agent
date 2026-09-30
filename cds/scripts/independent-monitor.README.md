# 独立 CDS 故障入口运维

探测器必须运行在 CDS 主机之外，页面由独立静态托管服务提供。当前部署入口及尚未接通项见 `doc/debt.cds.md`。

## 配置与启动

- Python 3，仅标准库。将 `independent-monitor.py` 放在专用服务目录。
- 配置 JSON 使用 `cdsBase`（HTTPS 控制台根地址）、`headers`（现有授权头）、`publicUrl`（独立页面地址）、`publishRepo`（已克隆的独立快照仓库绝对路径）。可选 `bark` 对象含 `key` 和 `serverUrl`。
- 配置、同目录 `state.json` 及专用 SSH 发布密钥均仅服务账号可读，配置权限必须为 0600，服务目录 0700。不要把真实配置提交 Git 或写进日志。
- 服务命令：`python3 independent-monitor.py --config /安全目录/config.json`；`--once` 执行一轮。每分钟检查一次；配置更新后重启本服务，不操作 CDS 主服务。
- 发布仓库只允许写独立静态站点。使用仓库级部署密钥和固定的 SSH known_hosts，不使用个人 token；探测机需要访问 GitHub 和 CDS。
- 用 systemd 设置开机启动、失败重启、专用用户、UMask=0077、NoNewPrivileges=true、PrivateTmp=true、ProtectSystem=strict、ProtectHome=read-only，仅开放本服务目录写权限，MemoryMax=192M、CPUQuota=20%。

## 页面发布

`independent-status.html` 是独立静态页面。发布副本的 `status-data-url` meta 指向静态仓库的 GitHub contents API 中 `status.json`；页面发送公开 raw media 请求，不需要凭据。模板留空时读取同目录快照。GitHub Pages 工作流仅在 HTML 或工作流变化时部署，状态快照更新不触发全站部署。

探测器只向仓库写白名单快照。公开页面每两分钟取数，超过三分钟明确标为过期；手动刷新、匿名限流或网络失败也不能显示为恢复。通知地址支持 `incident` 和 `target`，内部详情按钮保留监控目标。

## 状态与投递

能取得新鲜 CDS 汇总时，内部指标与采集故障由 CDS 通知；外部只在入口不可达、汇总失联或检查停摆时接管通知，避免两层重复推送。连续三次失败建立同一持续事件；严重度升级只提醒一次；持续通过十分钟关闭事件。采样中断不算恢复。先发布快照再发送消息；发送失败最多三次、间隔五分钟，接收方已受理但响应丢失仍可能造成重复，不保证网络层恰好一次。没有成功送达过故障消息，不发送恢复消息。投递记录仅保存在探测机，公开页面显示通道是否配置，不把配置等同于送达。

CDS 内通知通道可设置 `incidentPageUrl` 为独立入口。修改通道时保留已有项目、事件筛选及密钥，不从脱敏返回值覆盖真实密钥。

## 验证与恢复

`python3 cds/scripts/test-independent-monitor.py` 验证连续故障、稳定恢复、采样中断、事件升级、公开字段及发布失败后的待发状态。上线后核对 systemd 活跃、快照时间持续推进、事件编号保持不变、手机入口能打开且无横向溢出。

回滚时停用这个独立 systemd 服务，保留状态和投递记录；恢复旧版页面提交。旧快照会标为过期，不删历史数据或把故障手工刷绿。完整恢复需重新安全配置发送通道并验证手机接收；仅页面可打开不能关闭此待办。
