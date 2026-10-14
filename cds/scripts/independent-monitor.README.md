# 独立 CDS 故障入口运维

探测器运行在被检查 CDS 之外。所有真实身份、地址、凭据和运行记录保存在服务器私有目录，禁止提交 Git。仓库只保存程序、测试与空配置约定。

## 私有配置

- Python 3；依赖固定在 independent-monitor.requirements.txt。
- config.json 必须为 0600，目录 0700。字段包括 cdsBase、headers、publicUrl、identity、publicIdentity、publicConsoleUrl、storage；可选 bark。
- identity 包含 observer（检查方）、subject（故障对象），各自包含稳定 id、name、environment，可选 location。使用业务别名，不从 IP、主机名或域名猜测身份。
- publicIdentity 只放明确允许公开的 name 和 environment，公开投影忽略位置、地址、密钥和额外字段。内部监控项目与读数只留在私有状态。
- storage 使用 region、bucket、objectKey、secretId、secretKey，对象存储凭据只存在运行配置。对象仅发布白名单摘要，公开读取；为独立页面来源配置 GET/HEAD CORS，保留已有规则。
- publicUrl 为独立 HTML 页面地址，片段 feed 指向公开摘要。片段不发送到页面托管服务器；同一浏览器后续从本地保存的 feed 继续读取。不要把实际地址写进 HTML 源码或示例。
- bark 使用 key 与可选 serverUrl，仅私有文件可读；没有配置就明确显示未接通，不能视为已通知。

## 启动与维护

使用隔离 Python 环境安装固定依赖，运行 independent-monitor.py --config 加私有配置路径；--once 执行一轮。systemd 采用专用服务账号、开机启动、失败重启、UMask=0077、NoNewPrivileges、PrivateTmp、只读系统目录，仅开放服务数据目录写权限，并限制内存与 CPU。

每分钟检查一次；页面每两分钟读取对象存储，数据超过三分钟明确显示过期。运行快照不再通过 Git 发布，也不依赖代码仓库的提交历史或匿名 API 配额。更换存储时先验证新摘要 HTTPS 与跨域可读，再切换通知入口并停止旧发布器。

## 告警边界

CDS 能给出新鲜汇总时，内部指标告警由 CDS 发送；入口失联、汇总不可读或检查停摆时才由外部接管通知。连续三次失败建立事件；同一事件持续更新，严重度升级仅通知一次；连续正常十分钟后恢复，采样空档不计入恢复。

通知写明检查方与故障对象，按对象稳定 ID 分组。改名不改变 ID；不自动互相重启。先发布快照再发送，失败最多重试三次，间隔五分钟；没有成功送达过故障，就不发恢复。网络响应丢失仍可能导致重复受理，不承诺网络层恰好一次。

## CDS 身份设置

系统设置 → 通知 → 通知身份，可修改当前实例名称、环境和可选位置。管理员也可用 cdscli monitor identity 查看，或加 --file 从私有 JSON 配置更新。真实配置文件不可加入版本控制。对端目标身份由 targets 按监控 ID 明确关联，不以名字猜测。

## 验证与回滚

运行 test-independent-monitor.py，覆盖持续事件、稳定恢复、采样间断、身份白名单和通知深链。验收还需检查实际快照更新时间、系统服务运行、身份显示、手机推送受理与页面滚动。独立页成功不等于 CDS 内部修复上线。

回滚时恢复上一版程序与配置，保留私有事件和投递记录；不要恢复向 Git 发布运行数据。暂停探测会使页面明确显示数据过期。
