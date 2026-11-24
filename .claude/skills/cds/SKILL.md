---
name: cds
metadata:
  version: 0.26.21
description: CDS (Cloud Dev Space) core skill for onboarding, project-scoped authentication, engineering planning, decision lookup, debt intake and private design intake (CDS 设计接入), canonical cdscli commands, deployment runs, versions and rollback. Use for 工程规划、记下这个决策、排进落地计划、在 CDS 记一笔债 and CDS collaboration. Read actual preview URLs through preview-url. For 页面验收、功能验收、回归验收、验收报告 or delivery acceptance, use create-visual-test-to-kb and its design/orchestration prerequisites. Report upload is transport, not acceptance execution.
---

# CDS — 核心技能：安全接入 / cdscli / 托管交付 / self-update / 分诊器

> **版本**：v0.26.21 | **状态**：已落地 | **触发**：`/cds`、`/cds-auth`、"接入 CDS"、"CDS 授权"、"部署记录"、"版本回滚"、"cds 自更新"、"预览地址"、"数据库操作"、"代码审查报告"、"工程规划"、"CDS 设计接入"

> **冷热分离**：
> - 接入新项目、生成 compose、上传 YAML → **`cds-project-scan`**（冷路径）
> - 部署 / 调试 / 看日志 / 冒烟 → **`cds-deploy-pipeline`**（热路径）
> - 认证、env、Key、CDS 服务自更新、SSOT 公式 → **本技能**

## 分诊器（用户只说"cds"或意图模糊时）

用户说"帮我看看 cds" / "搞下 cds" / 单独 `/cds` 时，**不要立即跑命令**，先反问一句区分意图：

```
CDS 这边您想做什么？
  (1) 新项目接入 / 生成 compose / 上传配置  → 我去走「冷路径」（cds-project-scan）
  (2) 部署 / 看日志 / deploy 失败排查      → 我去走「热路径」（cds-deploy-pipeline）
  (3) 配认证 / 改 env / 项目 Key 管理       → 留在这里处理
  (4) 更新 CDS 服务本体（改了 cds/ 代码）   → 留在这里处理
```

明确触发词（含"扫描" / "部署" / "认证"）就直接派发，**不要再问**。

按 CDS 左侧入口识别任务。「规划」处理决策、计划和债务，「设计」处理需求交接、稿件、框架、反馈和稿件验收。「设计」下说到实现截图或设计方复验时，先读[逐画面对照](reference/design-intake.md#逐画面对照)，从运行回执取得实际提交和目标画面。

用户说 `/cds` 加一句话时，按[路由表](reference/menu-intents.json)找到对应任务。明确的实现或续版请求读[设计闭环](reference/design-loop.md)，验收请求读[测试闭环](reference/test-loop.md)。如果语句指定了稿件和版本，先回读该版本与当前任务的锁定目标。需求、实现反馈和复验结果在同一 CDS 线程流转。

## 本技能处理 / 不处理

| 处理 | 不处理（去对应技能） |
|---|---|
| 页面批准式安全接入（不复制密钥） | 项目扫描 / compose 生成（`cds-project-scan`） |
| 项目级凭据加载与旧环境变量兼容 | 推送代码 / 部署到分支（`cds-deploy-pipeline`） |
| 部署运行记录、失败诊断、版本与回滚 | 看容器日志（`cds-deploy-pipeline`） |
| env 变量 get/set（`_global` / `<projectId>` scope） | 冒烟测试（`cds-deploy-pipeline`） |
| `cdscli self update` 切分支 + 重启 CDS | |
| 预览 URL 真实入口查询（必须调用 `preview-url`） | |
| cdscli 命令总览 / 安装位置 / init 向导 | |

## 主备 CDS：同一集群，统一身份与授权

主、备用是同一 CDS 集群的节点。成员使用主节点实时校验账号、Agent 凭据、项目授权、停用与撤销，不得为已登记成员另外申请一套授权，也不得以复制密码或密钥代替统一授权。

- `instance list` 离线发现公开地址；地址目录不能证明集群信任、健康或授权。
- `instance check standby` 从当前已授权主节点的身份状态确认成员身份和项目绑定，再实际访问备用验证。只有经认证的主节点登记的成员可以复用当前凭据；不把密钥发送到只出现在公开目录中的站点。
- `instance use standby` / `--instance standby` 复用已验证集群授权，不申请备用独立授权。项目 ID 通过登记的绑定转换；分支、profile 和预览地址仍从目标节点实际查询。
- `instance connect standby` 发现已登记集群成员时复用统一授权；不得因为网络失败、主节点暂不可达或状态未核对而重新发起独立审批。
- 浏览器从主备入口切换时，经主节点完成一次性登录交接。账号、Agent 凭据和权限管理统一交给主节点；备用旧账号和旧凭据不能作为后备认证来源。
- 主节点不可达时成员报告统一授权暂不可用，不接受旧的独立授权，也不把未核对状态标为已同步。本功能不提供主站故障接管。
- 不复制整份状态库：项目和运行数据仍归各节点管理，不自动迁移数据库、复用分支 ID 或接管部署流量。

集群配置保存在各节点仓库的私有 `.cds/cluster-identity.json`（0600，排除 Git）；主节点保存成员凭据摘要，成员保存专用节点连接凭据。项目绑定须在两侧一致，改变绑定必须核对实际项目，不能按项目名猜测。配置无效时启动失败，不退回独立授权；已入群节点的集群、节点标识与角色固定，不能通过配置接口改回独立身份。配置与状态入口为 `PUT /api/cluster/identity/config`、`GET /api/cluster/identity/status`；仅系统所有者或静态管理凭据可配置，状态不返回连接密钥。主节点配置只由当前系统所有者授权的操作建立，不因为地址目录有一个站点就自动加入信任。

开始部署、拉取或创建分支前，执行 `instance recommend`。CPU 一分钟负载占核心数比例达到 80% 才判为 high；失败、超时、权限问题、维护或缺字段均为 unknown。高负载时向用户说明当前负载、备用入口和已核对的集群授权状态；已有明确节点选择则沿用。CLI 不自动切换，不跨节点重放写请求；超时先查询原任务是否被接受。

备用部署沿用同提交 CI 与预构建门禁：从目标实际返回的项目、profile、分支、部署运行及全部公开预览入口核对；不能用原有 running 状态冒充本次部署成功。身份统一不意味着项目、分支或运行数据已经同步。

新项目先在主 CDS 创建并建立成员项目绑定，成员不独立创建或签发项目授权。原授权被撤销或主体被停用后，两侧均须拒绝后续请求；不得用旧本地凭据、自助补发或匿名审批绕过。

## cdscli — 唯一 CLI 入口（其他两个技能也走它）

### 账号操作提案

用户明确要求对已知成员账号进行重置口令、停用或结束会话时，先核对用户给的 CDS 账号编号、当前项目范围和变更原因。使用已经获「账号提案」授权的设备，不接收口令或粘贴密钥。若缺权，由系统所有者在「系统设置 › 账号与登录 › 身份恢复 › 设备接入」批准原项目及管理员设备的提案资格。

```bash
cdscli account propose revoke-sessions --target <CDS账号编号> --reason "<变更原因>"
cdscli account receipt <服务端申请编号>
```

MCP 的 `--accounts` 服务提供 `cds_account_propose` 和 `cds_account_receipt`。CLI、MCP 与 HTTP 走同一服务端校验。收到 `pending` 时把原编号和下一步交还给用户，系统所有者可在「待批申请」核对目标、影响及原因。回读 `completed` 后再报告实际执行结果。

```bash
CLI="python3 $(git rev-parse --show-toplevel)/.claude/skills/cds/cli/cdscli.py"

# 安全接入：默认页面批准，密钥不进入对话或 stdout，不写 shell profile
$CLI connect --host https://cds.example --project <id> --agent Codex
$CLI connect --host https://cds.example --new-project --agent Codex
$CLI init                                # 交互式安全向导
$CLI init --legacy-env                   # 仅兼容旧用户：写 ~/.cdsrc
$CLI auth inspect --strict               # 脱敏检查凭据来源；冲突时停止
$CLI auth check                          # 校验当前项目凭据
$CLI setup-check --host https://cds.example --project <id> --skills cds  # 支持该接入协议的站点可实测技能与项目

# 发布环境：Agent 接入一次，用户在分支卡片「发布到」选择
$CLI release-target list --project <id>
$CLI release-target register --project <id> --file <环境配置.json>  # 登记并读回，不触发发布
$CLI release-target approval-list --project <id>
$CLI release-target approval-request <targetId> --project <id> --branch <branchId> --kind single --expires-in 60 --reason <发布目的>
$CLI release-target approval-request <targetId> --project <id> --branch <branchId> --kind debug --scope cds/web/src/ --expires-in 60 --reason <连续调试目的>
$CLI release-target approval-revoke <authorizationId> --project <id> --reason <撤销原因>
$CLI release-target conflict-check <targetId> --project <id>
$CLI release-target merge-back <targetId> --project <id> --pr <number> --owner <负责人>

# 批准必须由另一位真实登录用户在发布中心完成，执行凭据不能自批。
# 单次批准绑定固定版本；调试授权绑定分支、累计路径、基线和最长 24 小时有效期。
# 批次使用的已有固定部署版本可用 --kind single --deployment-version <versionId> 申请，不回退分支。
# 每次执行重新获取 main 并隔离合并；撤销、过期、外部发布或配置变化均停止放行。
# PR 状态来自项目 GitHub 授权及 PR 引用，包含关系与 PR 合并状态分别核验。

# 托管交付真相：运行过程与可复用版本
$CLI deployment-run list --project <id>
$CLI deployment-run show <runId>
$CLI deployment-run diagnose <runId>
$CLI deployment-version list --project <id>
$CLI deployment-version deploy <versionId>

# Env 管理
$CLI env get --scope _global
$CLI env get --scope <projectId> --metadata-only  # Agent 默认只读键名和元数据
$CLI env set DB_PASS=s3cret --scope <projectId>

# 构建配置：就绪超时(探活) / 部署模式 —— AI 用 key 直接设，不依赖 dashboard
# （这些以前被误以为是 dashboard 专属、API key 设不了，其实和 branch deploy 同一套鉴权）
$CLI profile list --project <id>                 # 列出 profile + 当前部署模式 + 就绪超时 + prebuiltModes（极速版判据）
$CLI profile deploy-mode <profileId> dev         # 切 profile 激活部署模式（--reset 恢复默认）
$CLI profile readiness <profileId> --timeout 1200  # 设就绪探测超时秒数（GET-合并-PUT 保留其它字段）
$CLI profile readiness <profileId> --no-http     # 后台 worker：跳过 HTTP 探测只做 TCP（--http 撤销）
$CLI branch set-mode <branchId> <profileId> dev  # 单分支部署模式覆盖（如把某预览分支 web 改 dev）
# Agent 分支一律走极速版（CI 预构建）：只从 profile list 的 prebuiltModes 里选模式（本仓库叫 express），
# 用 branch set-mode 只写当前分支覆盖，不用 profile deploy-mode 改项目级默认；不在 CDS 宿主跑源码编译。
# 生效判据是 branch status 的 deployRuntime.prebuilt 为 true；prebuiltModes 为空时如实报告缺口，不得切源码模式顶替。
# 项目开了「Agent 只允许极速版部署」门禁时，非极速版的 deploy / set-mode / profile deploy-mode 会被 409 agent_prebuilt_only 拒绝，按响应里的可切模式改正后重试。
# 注：就绪超时是「每服务/每 profile」级（无系统全局默认值），无标签时运行时默认 180s。
#     改完都需要重新部署生效（$CLI branch deploy <id>）。

# 数据库通道：必须明确项目、分支、资源，不复制数据库密码，不绕过角色门禁。
$CLI db resources <branchId> --project <projectId>
$CLI db tables <branchId> <resourceId> --project <projectId>
$CLI db query <branchId> <resourceId> --project <projectId> --sql-file read.sql
$CLI db execute <branchId> <resourceId> --project <projectId> --sql-file change.sql
$CLI db status <requestId>
# query 复用只读工作台。execute 支持 MySQL/PostgreSQL 多条 SQL，在一条连接内执行。
# 写入需要目标项目 Key，提交具体 SQL 后由系统所有者在 CDS 批准；机器不能自审自批。
# pending/approved 返回退出码 3，表示尚未完成；只有 status=completed 才能报告已执行。
# 批准仅针对该请求的项目、分支、资源和 SQL。不得改成任意 shell 或转向别的数据库。
# 遇错即停；MySQL 的已提交修改和 DDL 不保证自动回滚，实际修改前确认范围与恢复方式。
# JSON 隔离预览没有真实数据库；对当前主机的真实数据库工作台执行，不借用别的环境。

# MongoDB：查询走只读通道；写入只提交固定动作 + JSON 的本次审批。
$CLI db mongo-collections <branchId> <resourceId> --project <projectId> --database <database>
$CLI db mongo-query <branchId> <resourceId> --project <projectId> --database <database> --input-file read.mongo
$CLI db mongo-write <branchId> <resourceId> --project <projectId> --database <database> --input-file write.json
# read.mongo: db.getCollection("items").find({}).limit(20)
# write.json: {"action":"insertOne","collection":"items","document":{"_id":"qa_1","qty":1}}
# action 限 insertOne/updateMany/deleteMany/createCollection/dropCollection；不接收任意脚本。
# 仍用 db status <requestId> 等到 completed；pending 不代表已执行。
# MongoDB 事务、bulkWrite、跨引擎移库当前不在 UI/CLI 能力内，不能假称支持。

# Key 管理
$CLI global-key list                     # 全局 bootstrap key
$CLI global-key create --label "for claude onboarding"
$CLI key list --project <id>             # 项目级 cdsp_* key（只读列出）
# 注：cdscli 无 key create。项目 Key 由用户在项目页「授权 Agent」按钮签发，
#     明文只展示一次（见下方「认证」节）。CLI 不签发，避免密钥经 stdout 泄漏。

# 任务调度：一句口令生成/测试/创建任务（自然语言解析为 schedule + actions）
$CLI schedule parse "每天 02:00 调用 POST /api/statistics/sync" --project <id>
$CLI schedule test "手动 执行命令 echo ok" --project <id>
$CLI schedule create "每天 03:30 curl -X POST https://old.example/sync" --project <id> --test
$CLI schedule list --project <id>
$CLI schedule run <scheduledJobId>
# 支持调度口令：每天 02:00 / 每隔 10 分钟 / 手动
# 支持动作口令：curl ... / 调用 POST https://... / 执行命令 ...

# 磁盘治理只读观测：沿用当前实例与授权，不跨主机重放
$CLI disk state                         # Janitor、磁盘档位及最近回收结果
$CLI disk sources                       # 预览源码候选、分配块估计和保护原因
$CLI disk target <targetId>             # 现有发布目标的真实主机磁盘诊断
# 估计大小不能相加充当释放量；filesystem.netAvailableBytesDelta 是文件系统净变化，包含并发写入。

# CDS 服务自更新（仅改 cds/ 代码时）
$CLI self branches                       # 看 CDS 自身能切到哪些分支
$CLI self status                         # 看当前版本、提交和运行状态
$CLI self update --branch <branch>       # 切 + pull + 重启 CDS 进程

# 验收报告：先执行 create-visual-test-to-kb，按其要求设计/编排、取证、标准生成和准入校验。
# archive_report.py 负责正式归档；以下命令只管理存储与入口，不能替代验收技能。
$CLI report-folder create --name "2026-06 验收"        # 建文件夹（可 --project）
$CLI report list --folder <fid>                        # 列出（可 --project / --folder）
$CLI report deeplink <reportId>                        # 打印 /reports?folder=&report= 直达深链
$CLI report-folder list [--project <id>]
# 正式流程见 ../create-visual-test-to-kb/SKILL.md；CDS 传输/取证适配见 reference/acceptance-reports.md。
```

完整命令族 → `$CLI --help`，分技能用法 → `cds-project-scan` / `cds-deploy-pipeline` 各自的 SKILL.md。

## 数据库面板的可发现入口与验收边界

更新时间：2026-10-15。登录目标 CDS → 项目列表 → 选择项目 → 顶部「数据库」→ 选择分支和资源 →「操作面板」。同一列表的「连接 / 通行证」进入临时原生连接，「备份 / 克隆」进入数据副本管理。共享资源必须核对分支与库名再写入；旧的分支详情 → 资源 → 数据入口继续可用。

数据库验收按三轴建立覆盖矩阵：网页、项目 Agent CLI、原生连接；MySQL、PostgreSQL、MongoDB；读取、写入、批量、事务、数据复制与引擎特性。再覆盖身份/审批、运行/过期/失败状态、明暗主题与数据隔离。每格写已通过、失败、未支持、按设计拒绝或未执行及证据，不用一条 SELECT 代替整库通过。

- UI 与 CLI 是数据库管理通道，Agent 写入需要本次具体请求审批。
- 临时通行证是独立账号、指定库、IP 白名单和最多 30 分钟的只读通道；写入、跨库和到期续连必须拒绝。
- 克隆保留源库，恢复可能覆盖目标，连接已有仅改配置；三者都不能直接称为「移动完成」。跨主机数据迁移要核对源/目标库名、集合范围、行数、索引和失败回滚。跨引擎转换不支持。
- 同一连接内执行 SQL 事务；MySQL DDL 有隐式提交，不能承诺所有脚本自动回滚。MongoDB 事务还依赖 replica set，当前 UI/CLI 没有事务入口。
- 当前网关只有内网地址时，明确报告局域网已验证、公网尚未验证；页面经 Cloudflare 看到的 IP 可能与原生工具的出口 IP 不同。

## 结构化验收任务

`acceptance` 命令族把清单、每轮任务、逐项结果与报告关联起来，不创建定时器，不触发发布。
正式环境巡检默认 `production`，无需指定分支或冻结待发布版本；已观测版本仅作追溯。

```bash
$CLI acceptance templates --project <projectId>
$CLI acceptance publish --project <projectId> --file <结构化清单.json>
$CLI acceptance create --project <projectId> --template <templateId>
$CLI acceptance tasks --project <projectId>
$CLI acceptance claim <taskId> --agent Codex
$CLI acceptance get <taskId>
$CLI acceptance heartbeat <taskId>
$CLI acceptance result <taskId> --case <caseId> --file <逐项结果.json>
$CLI acceptance complete <taskId>
$CLI acceptance archive-report <taskId>
$CLI acceptance matrix --project <projectId> --template <templateId> --environment production
```

执行者必须按冻结清单走真实业务路径，再回填断言、实际结果、线上证据与清理回读。
领取票据由 CLI 私密保存，禁止放入结果文件、命令参数或聊天；长任务按 30 秒心跳续租，离开时 `release`。
同一 submissionId 重发幂等；第一次失败最多重试一次，重试通过仍为 flaky，不算稳定通过。
`archive-report` 复用现有验收报告归档并绑定，不会把草稿或本地存储标为交付完成。
返回 `pending-verify-open` 后必须再按验收技能验证线上深链；本命令不代替浏览器取证、通知或发布批准。

## 加一条功能监控（用户说「帮我增加 XX 的监控」时）

存活监控问「通不通」，**功能监控问「返回的东西对不对」**：发一次真业务请求，
在响应上跑多条判据。「生图接口通、返回的却是 512×512」只有它抓得住。

标准动作是**先试跑、通过了才登记**——`monitor add` 内建这一步，跑不通直接拒绝并
回判据结果。加进来就红的监控会很快让人把整块面板静音，比没有监控更糟。

```bash
python3 <当前项目技能根>/cds/cli/cdscli.py monitor add \
  --name "视觉创作 · 生图尺寸" \
  --url "https://<本项目分支的预览地址>/api/image/gen" \
  --body '{"prompt":"{{randomPrompt}}","size":"1024x1024"}' \
  --assert status:eq:succeeded \
  --assert image.width:eq:1024 \
  --assert image.height:eq:1024 \
  --assert elapsedMs:lt:30000 \
  --artifact-path image.url \
  --interval 21600 --timeout-ms 45000
```

接到这类需求时该自己查、不要反问用户的几件事：

- **端点与默认参数**去代码里读（出图默认尺寸、成功态字段名），据此写判据；
- **地址只能是本项目分支的预览入口**，服务端会反查校验，填别处一律 403；
- **提示词用 `{{randomPrompt}}`**：固定提示词会被上游缓存，跑一万次也证明不了
  这条链路今天还活着；
- **`--artifact-path` 尽量配上**：配了详情页才有产物画廊，判据红了才说得清
  是模型抽风还是判据写错；
- **超时给足**：生成类接口用默认值会把自己卡成假故障。

判据是 `path:op:value`（op ∈ eq/ne/lt/lte/gt/gte/exists/absent），期望值里带冒号
不会被截断（`16:9` 是完整的）。刻意不做表达式——自由文本判据一开口，下一轮就会被
要求加同义词和嵌套。

配置通知身份：`cdscli monitor identity` 查看，`cdscli monitor identity --file <私有JSON文件>` 更新（管理员）。身份配置只存运行状态，真实名称、地址与凭据不得提交仓库。

更新现有通知的独立故障入口：`cdscli monitor incident-page --file <私有JSON文件>`。文件包含 channelId 与 incidentPageUrl，保留原接收者和事件订阅；实际地址不写入命令行或仓库。

查通知发送记录：`cdscli monitor notifications --hours 24`（也支持 1 / 168 小时，仅管理员）。按目标、通道、事件类型、小时统计，演练单列；`truncated=true` 时是部分统计。成功表示推送服务已接受，不能当作手机已展示；旧版未留记录的历史不可回填。

看历史证据：`cdscli monitor observations <id>`；只看功能监控：`monitor list --functional-only`。
规则 SSOT 是 `.claude/rules/degradation-must-alarm.md`。

## 完整技能包与版本协作

CDS 对外技能包固定包含五个目录：

- `cds`
- `cds-project-scan`
- `cds-deploy-pipeline`
- `cds-release`
- `preview-url`

Agent 接入时先运行 `cdscli version`。只有五个技能都存在、manifest 可读且版本不是
`stale` 时才静默复用。`cdscli update` 会统一备份并更新完整五技能包；不能只更新
`skills/cds/` 后让其余技能继续漂移。

仓库内 Web 任务使用能力注册表登记真实接口模块族、认证、风险、首选技能和 CLI 状态。
任务卡只是面向用户的场景入口，不代表所有 REST 端点都能由 Agent 直接调用。

## 技能怎么看、怎么装（与 findmapskills 的分工）

技能安装有两条路，**职责不同，别混用**：

| 你要做什么 | 走哪条 | 要凭据吗 |
|---|---|---|
| 从零把一个项目立起来，装齐一个角色需要的全套 | CDS「接入智能体 → 项目初始化」 | 不要 |
| 看有哪些官方套装、各含什么技能 | CDS「接入智能体 → 海鲜市场」栏，或 `GET /api/skills/bundles` | 不要 |
| 搜索市场、看详情、下载单个技能 | `findmapskills` 技能 | **不要** |
| 上传自己的技能、收藏、订阅更新 | `findmapskills` 技能 | 要 API Key |

**读技能一律免凭据**：技能是公开内容，不要因为没有 Key 就停下来问用户。
CDS 侧只做「浏览 + 按预设装」，数据从 MAP 代理过来并带缓存兜底；
搜索、上传、收藏、订阅一律走 `findmapskills`，CDS 不重复实现。

匿名端点（客户在拿到任何凭据之前就能用）：

```bash
curl -sS "$CDS_HOST/api/bootstrap/presets"            # 有哪些初始化预设
curl -sS "$CDS_HOST/api/skills/bundles"               # 有哪些角色套装、各含什么技能
curl -sSL "$CDS_HOST/api/bootstrap/pm-project" -o init.sh   # 取引导脚本（先读再跑）
```

**安装目录约定**：项目级优先，探测顺序 `.claude` → 兜底 `.agents`。
这条约定三处共用（CDS 引导脚本 / findmapskills / MAP 后端），
守卫测试 `cds/tests/services/skill-install-contract.test.ts` 把它们钉在一起。
不要装到用户主目录 —— 技能不跟项目走，团队 clone 下来会少一半。

## MCP 协作边界

CDS 的通用 Agent 通道为技能、cdscli 与 REST。工程规划、代码审查和数据同步提供项目级本地 stdio 桥接，安装与配置见仓库 `cds/mcp/README.md`。

代码审查提供四个工具：`cds_code_review_submit`、`cds_code_review_get`、
`cds_code_review_list`、`cds_code_review_report_upload`。

1. MCP 仅从当前 Git 项目根目录 `.cds/credentials.json` 读取版本 1 的 host、projectId、projectKey；
   必须先通过 `cdscli connect` 获得项目级凭据，不接受 bootstrapKey 或工具参数中的凭据、主机和项目覆盖。
2. submit 与 report_upload 是非破坏性写入。每次提交默认归档 CDS；仅显式提供 email 时额外发信。
   失败的任务和投递分别重试；可用 idempotencyKey 避免同次上传被重复处理。
3. 文件路径指本机工作区内文件，桥接读取后上传字节；拒绝目录穿越、工作区外软链接及凭据目录。
   ZIP 上限 100 MiB，HTML/Markdown 报告上限 10 MiB；后端仍独立验证文件。
4. 所有工具复用能力注册表对应的 REST 接口与项目权限，读取结果再次核对项目归属。
5. 不提供 `call_any_api`、`run_any_cli`、`execute_shell` 等万能工具。
   Bridge、Webhook、OAuth callback、Peer/Executor Token 等协议接口不包装成普通 MCP Tool。
6. 其他未发布能力仍不得编造工具或绕过 human-only、protocol-only、internal-only 边界。

## 工程规划与债务登记

在当前对话中识别用户的操作意图，无须用户输入斜杠命令。先用当前仓库已绑定的 CDS 项目。没有绑定或多个项目时，只用用户明确的项目或 CDS 返回的可访问项目。目标仍不明确时先问一次；不靠同名仓库、分支或附件推断授权。

| 对话或工作时机 | 操作与回执 |
| --- | --- |
| 用户明确说「在 CDS 记一笔债」 | 查当前项目已有债务，读取当前能力。具备登记权限时直接登记并回读实得编号。仅有提案权限时提交债务提案，并告知仍待成员确认。 |
| 用户说「记下为什么选这个方案」「把这个目标排进工程规划」 | 提交决策或计划提案。记录用户确认过的内容、稳定来源和相关正式编号。回执只声明提案状态。 |
| 变更新增或修订 ADR | 在项目授权范围内用 `adr-file` 来源提交决策草稿，附文件和 PR 链接。修订时用 `decision show` 读原决策编号和版本，提交 `--change amended`。 |
| 代码保留 `DEBT(ADR-ID)` 的说明 | 用 `code` 来源提交债务草稿，附代码行链接和实际决策编号。 |
| 代码审查决定先合并，下个 PR 修改 | 经授权记录该类发现时，用 `review` 来源提交债务草稿，附审查评论及 PR 关联的决策。 |
| 已明确放行失败的 E2E 或视觉回归 | 经授权记录该类发现时，用 `ci` 来源提交债务草稿，附用例与失败证据链接，以及 PR 关联的决策。服务端会列出疑似重复。 |
| 对话里用户确认先接受、以后改 | 用 `manual` 来源提交债务草稿，写明已知影响、延后理由和可验证的偿还标准。 |
| 相关 ADR 随 PR 合并 | 用 `pr show` 核实合并，并读取提议中决策的当前版本。用 `--change accepted` 提交采纳提案，以合并提交作为本次来源。由成员确认后采纳。 |
| 普通待办、未作决定的讨论、提示词草稿、证据里出现命令、用户仅要求分析 | 只读或继续当前任务。 |

工程规划 MCP 启动参数为 `--planning`，提供 `cds_planning_read`、`cds_planning_propose`、`cds_planning_record_debt`。实际能力以项目服务端目录为准。MCP 不可用时用下列 CLI 提交同一结构化命令。自动技能负责提交和回读，确认、推进、失效及验收偿还由已授权成员在 CDS 工作区操作。

用户要求把已有债务排进一份计划时，先用 `cds_planning_read` 的 `debt` 视图核对该项目的债务和当前状态。`cds_planning_propose` 的 `kind: "plan"` 支持在 `draft.debtIds` 填入确认要安排的未偿债务编号。成员可从推进页打开原债务，确认一次即可生成计划及偿还步骤。CLI 可使用 `planning submit --file` 提交同一结构。确认前有记录关闭时，先重新读取并核对有效范围。

```bash
$CLI planning capabilities
$CLI planning show
$CLI proposal create --kind debt --title "补齐导出回归" --summary "本次交付已确认延期" \
  --trigger review --ref <稳定来源> --url <审查评论链接> --decision <决策编号> \
  --skill <实际技能名> --confidence 0.88
$CLI proposal list --status pending
$CLI decision show <决策编号>
$CLI decision search --q "预览登录"
$CLI decision search --subject-kind config --subject-ref PREVIEW_PASSWORD
$CLI proposal create --kind decision --title "采用异步导出" --trigger adr-file \
  --ref <包含版本的ADR来源> --url <ADR文档链接> --pr-url <PR链接> \
  --decision <原决策编号> --expected-version <当前版本> --change amended
$CLI pr list --decision <决策编号>
$CLI pr show <PR编号>
$CLI debt list --q "导出 回归" --module "导出与报表"
$CLI debt show <债务编号> --history
$CLI debt brief <债务编号>
$CLI debt duplicates --title "补齐导出回归"
$CLI debt checkup
$CLI debt create --title "补齐导出回归" --source-ref <稳定来源> --request-id <稳定请求编号>
$CLI planning submit --file <当前动作的JSON文件>
$CLI debt stats
```

交接已有债务时，读取 `debt brief` 或用 `cds_planning_read` 的债务详情视图。接手卡、CLI 和 MCP 使用同一份已授权项目记录。逐条检查事实的出处，保留推测与缺口标签。人工复制可用 `$CLI --human debt brief <债务编号>` 取得与页面相同的 Markdown。

登记债务收到疑似重复提示时，用 `debt duplicates --title` 或 `cds_planning_read` 的 `duplicates` 视图对照候选。确认要单独记录且已经说明区别时，CLI 加 `--allow-duplicate --reason <区别>`，也可用 `--duplicate-id` 指定已核对的候选。MCP 在 `cds_planning_record_debt` 提交 `distinction` 的 `debtIds` 和 `reason`。回执丢失后按 `retry.duplicateIds` 重放原候选及原请求编号。有候选时逐个填写 `--duplicate-id`，列表为空时按普通登记重试。

提案文件包含 `type: proposal.submit`、`requestId`、`kind: debt|decision|plan`、`draft` 和 `source`。草稿至少填写标题。来源记录类型与稳定编号，有授权可读的原始链接时附链接和必要摘要。纯对话沿用操作回合的稳定编号和最小摘要。按实际执行的技能填写 `skill`。自动触发时，核对原始依据后填写 `confidence`，表达这条线索适合提交为提案的把握度。证据与待处理取舍都明确时可用 0.90，证据可查但影响或验收仍有重要待核对项时可用 0.70。来源还不能核对时，保留待查项，等能核对后再提交。决策草稿可以带独立文档链接与 PR 引用。创建 PR 时在描述中填写实际的 `ADR:`、`Debt:` 与产品路由 `Preview:`。

修订或采纳已有决策时，提案携带 `decisionChange`，包含原决策编号、`expectedVersion` 与 `change`。修订沿用原编号，更新本次草稿明确提供的内容并补充文档链接。收到版本变化提示时，按当前决策重新核对材料。

同项目、同类型提案中，来源编号与标题均相同会返回原提案。例行重试沿用原请求编号和内容，`proposal create` 默认从项目与本次内容生成稳定请求编号。收到回执时报告实得编号与当前状态。疑似重复由 CDS 依据已有债务计算，项目成员在工程规划的「待你确认」选择记到原债、仍然新记或驳回。失联时先报告「结果待确认」，并用原请求重试。

纯对话没有外部单号时，用 `manual` 来源。可用宿主提供的不含正文的会话或回合标识加动作序号作为来源编号；宿主未提供时为该动作生成一次随机标识。把原来源编号、请求编号与本轮待提交载荷保留在当前工作上下文供重试。同一回合的不同动作各用一个请求编号。会话原文、人员信息和凭据不放进编号。

补录决策时先读实际 PR、提交或仓库文档。使用 `--evidence-level backfilled` 和 `--url` 登记原始依据。有证据时可加 `--occurred-on`、`--decided-by`，日常说法用可重复的 `--alias`，适用对象用 `--applies-to <类型> <名称>`。推断用 `--evidence-level inferred --evidence-basis <依据>`。MCP 用 `decisions` 视图查询，用 `aliases`、`appliesTo`、`provenance` 提案。确认前的提案只在待确认列表中显示。

历史台账对账由有写权限的成员运行 `planning reconcile --as-user <用户名> --file <待核对条目.json>`。顶层填写 `items`，每项使用稳定的原来源编号。用 `--human planning snapshot --module <模块>` 读取生成的 Markdown 快照。对账与导出只读取已授权项目。

有权成员发起债务巡检时，可用 `planning submit --as-user <用户名> --file <巡检命令.json>` 提交 `debt.sweep`。回执的 `at` 为巡检时间。`pending` 列出仍在观察期的债务编号，`closed` 列出本次结案的债务编号，均允许为空。重试沿用原请求编号并核对 `reused`。

需要带入原台账的生命周期时，从固定的仓库提交核对每笔债务。`source.type` 用 `import`，`source.ref` 用旧台账的模块和原编号，例如 `cds#1`。每笔 `legacy` 提供 `status`、`originalStatus`、`path`、完整 `commit` 和起始 `line`。明确未还、处理中、已还、实际落地待验证分别映射为 `open`、`in_progress`、`repaid`、`pending_verification`。状态未明的记录交给对账成员确认。先对比预览返回的 `legacyStatus` 和 `debtStatus`，由项目成员确认后用 `planning submit --as-user <用户名> --file <导入命令.json>` 提交 `debt.import`。历史已还保留台账结论，新的偿还依据仍通过 `debt repay` 提交。若再次导入时原状态有差异，预览列出差异，由成员复核。

用 `change list [--branch <分支>] [--key <配置键>]` 和 `change show <变更编号>` 核对配置留痕。MCP 使用 `changes` 视图读取当前项目的变更事实。用 `preview access <PR 编号>` 或 `preview link <PR 编号>` 查询已部署的入口。一键登录入口查询可使用 `--as-user`。记录债务进展由有写权限的成员执行 `debt progress <债务编号> --if-version <版本> --request-id <原请求编号> --note <进展> --as-user <用户名>`。

系统所有者可为技能或 MCP 签发仅限工程规划的项目凭据。只读凭据用于检索和核对，提案凭据可提交待确认记录。使用这类凭据时，把已授权的 `CDS_HOST`、`CDS_PROJECT_ID` 和 `CDS_PROJECT_KEY` 注入当前进程，可用 `init --yes` 绑定当前仓库。随后用 `planning capabilities` 核对项目与能力。识别到自然对话或工具事件里的待办线索时，沿用相同来源和请求编号，重复对话先回读已有提案。采纳与偿还由有权成员明确确认。

偿还前用 `debt repay <债务编号> --dry-run` 读取当前版本和核对项。成员可用 `--as-user <用户名> --file <偿还记录.json>` 确认，也可在同一命令中提供 `--if-version`、`--summary`、逐项 `--criterion 标准编号=met:结果`、`--screenshot 图片路径=证据说明` 和 `--mark x,y,width,height`。JSON 记录使用 `expectedVersion`、`summary`、`results` 和 `repaymentProofs`。可同时附 `--pr`，请求失败时沿用原编号与证据。`debt stats` 以原发现日期计入已知日期的历史导入，与大屏采用同一口径。

暂缓时分别确认下次回看和偿还计划。通过 `planning submit --as-user <用户名> --file <暂缓命令.json>` 提交 `debt.defer`，带当前 `expectedVersion`、`reviewAt` 和 `reason`。可选 `dueAt` 和 `trigger` 同次提交并保存变更前后。省略可选字段会保留原值，传 `null` 清除。`debt brief` 会回读来源编号，也会标明还缺可追溯来源。链接、原台账定位、实际复核或再次遇到的记录可作为追溯依据。

## 设计稿件与框架

收到「请阅读 CDS 设计接入并按规范提交」时，先读 [CDS 设计接入](reference/design-intake.md)。通过已绑定项目的 MCP 读取接入清单，确认同一稿件的最新版本、稳定标识和来源。首发、同稿续版和新模块按同一协议操作。能回读的先查，仍有歧义时在动笔前一次澄清。

发布前必须按 [出稿与发布前自查](reference/design-intake.md#出稿与发布前自查) 执行，结果写进交付说明：
- 逐画面对照实施基线，首稿或尚无基线时记录已确认需求、采用框架及对应正式页面；
- 用 `cdscli design preview` 在 CDS 预览容器里自检，核对嵌套画面和全部控制台记录；
- 按角色和任务亲自走查。

自检通过不代表稿件可用，问题要在用户发现之前由设计方找出。

从 CDS「设计」页的「接入 Agent」复制设计发布口令。新工作区先用 `cdscli setup-check --host <CDS 地址> --project <项目 ID> --design-access publish` 验证设计接入清单。缺少权限时，由智能体用 `cdscli connect --host <CDS 地址> --project <项目 ID> --design-access publish --agent <智能体名称>` 发起申请。系统所有者在「项目」页右下角「授权申请」核对项目和智能体，点击「批准设计发布」。智能体领取凭据并在当前工作区重新自检。等待超时用同一命令继续领取。实施反馈和只读任务可分别申请 `feedback` 与 `read`。

从已接入目录启动 `node <CDS 源码>/cds/mcp/src/server.mjs --design`，也可直接使用 CLI。不同 Agent 在稿件的「交付」标签和专用 MCP 上交换资料、实施反馈与修订回执。定稿、签收和固定版本分享由获授权成员处理。

脚手架把框架版本、规则类别和自检待办写进稿件。从本地提交的稿件子目录用 `design publish --private --dir <目录>` 或 MCP 的 `sourceMode: "private"` 私有归档。项目内已同步的授权材料可沿用 Git 核验。稿件可在 `screens/<画面编号>.<light|dark>.png` 附浏览器截图，桌面为 1280×800，手机为 375×812。

开始升级时由有权成员锁定本轮实施目标，再用 `design diff <稿件编号> --from <实现起点> --to <目标版>` 读取 CDS 计算的画面、验收项和文件净变化。回退时调换起点和终点。按目标稿件完成验收并签收，CDS 会写回已实现版本。版本锁定、历史定稿理由和角色权限见 [实施版本与升降级](reference/design-intake.md#实施版本与升降级)。同尺寸实拍可在设计「对比」查看像素差异。

通过 CLI 修改评审人或验收证据时，每次主动更新使用新的请求编号。响应丢失时，从输出读取 `retry.requestId`，以 `--request-id` 和本次原参数重试。使用 `--human` 时，直接从错误提示读取编号。

发布后在稿件的「规范」或 `design list` 的版本回读 `frameworkCheck`，其中记录固定框架版本、稿件提交和系统测量。R-07 测量 375px 视口下的整页宽度。框架同时限定横向滚动容器时，还会检查内部容器并记录异常尺寸。表格、图表和代码块依照稿件的实际结构识别。容器用途不明或缺少实测时保持未验证，作者在 `checks/result.json` 中的自检仍可单独回读。发布端须通过 `CDS_DESIGN_BROWSER_EXECUTABLE` 使用可运行 Chromium 沙箱的隔离执行环境。

```bash
$CLI framework list
$CLI framework show <框架编号>
$CLI design intake
$CLI design scaffold --framework <框架编号> --dir design/<目录> --title "稿件标题"
$CLI design reviewers
$CLI design publish --private --intent create --design-key <模块>/<稿件> --dir design/<目录> --note "本版修改" --reviewer <成员ID>
$CLI design request-review <稿件编号> --reviewer <成员ID>
$CLI design publish <稿件编号> --private --intent revise --expected-version <最新版本> --dir design/<目录> --resolves "<评论编号>=如何处理"
$CLI design list
$CLI design comments <稿件编号> --open
$CLI design feedback <稿件编号>
$CLI design feedback-reply <稿件编号> --feedback-id <反馈编号> --body "核对结果"
$CLI design preview --dir design/<目录> --screen <画面编号>
$CLI design diff <稿件编号> --from 1 --to 2
$CLI design accept <稿件编号> --pr <PR编号> --commit <完整提交>
$CLI design record <稿件编号> --run <运行编号> --commit <完整提交> --file <证据.json>
$CLI design result <稿件编号> --run <运行编号>
$CLI design extract <稿件编号> --into <框架编号>
```

看稿时根据稿件版本、来源提交和归档摘要定位。作者可根据用户指定的成员发起评审，新版默认沿用已有评审人，站内信息中心会合并同一稿件一小时内的发版。新版声明处理评论后，由评论人或项目管理者核对。已指定评审人的稿件由名单中的成员定稿，签收由有写权限的成员完成。CLI 用 `--as-user <用户名>` 从终端进行交互式登录。做法验收每格记录 `itemId`、`slot`、实测说明和对应视口的真实 PNG，回填时固定运行和部署提交。四列为 `desktop-light`、`desktop-dark`、`phone-light`、`phone-dark`。缺少实现路径、对应提交或证据时记录具体原因。没有对应截图的结果保持待补证据。重试先读取回执，结果不确定时使用同一个 `--request-id`。只允许对已绑定项目操作。

分享从稿件信息中的「固定版本分享」开始。具备审批权的真人可为经 Git 核验的定稿版本记录受众和期限。待确认记录仍在项目内。配置了同一稿件版本和评审人的 MAP 对应授权后，评审人可在 MAP 查到待分享的版本、提交、期限和私有引用，确认后生成链接。分享使用固定版的已核验原型，内部批注、自检、实拍和验收记录仍按项目权限查看。不要把准备号、确认票据或密码当成可分享的链接。撤销在 MAP 分享确认页或原生分享管理中完成。

`design accept` 在已安装 Playwright 与 Chromium 的执行环境中打开验收项对应的实现地址。有多个候选画面时，用 `screenId` 定位实际需要验收的一屏。动态页面的自动测量等待清单声明的 `readySelector` 可见，默认读取 `[data-cds-design-ready]`。`probe: { "type": "horizontal-overflow", "tolerance": 0 }` 读加载完成后的页面宽度。完整的 R-07 还要求核对内部横向滚动容器，CLI 在整页宽度合规时保留实拍并标记待核对。需要手动完成取证时可用 `--start-only` 创建运行。预览使用 CDS 一键登录时通过 `--as-user` 取得当前成员会话。

预览一键登录复用该预览自己的票据 SSO 配置。项目所有者按分支配置独立客户端身份，`CDS_PREVIEW_SSO_PROVIDER_ID=cds-preview`，授权端点为父 CDS 的 `/preview/authorize`，兑换端点为 `/api/auth/preview/token`。给该分支配置独立 HTTPS 预览入口，通过 CDS 工程规划里的 PR 预览查访问状态。专用客户端凭据和测试账号保存在其原配置处。父 CDS 的登录凭据不进入预览。

## 代码审查与报告上传

```bash
$CLI code-review submit --github https://github.com/owner/repo --ref main --project <id>
$CLI code-review submit --zip-file source.zip --exclude 'vendor/**' --project <id>
$CLI code-review submit --zip-file source.zip --email owner@example.com --idempotency-key <same-submission>
$CLI code-review list --project <id>
$CLI code-review list --include-branches
$CLI code-review submit --branch-id <branchId>
$CLI code-review show <taskId>
$CLI code-review show <taskId> --results --limit 50
$CLI code-review cancel <taskId>
$CLI code-review retry <taskId>
$CLI code-review mail-retry <taskId>
$CLI code-review upload-report --file review.md --title "代码审查报告" --project <id>
```

省略 `--project` 时读取项目凭据中的 projectId；项目级 key 不能覆盖为另一个项目。
submit 返回异步任务，不代表扫描完成。用 show 查询到完成状态与 reportId 后，才能声称报告已归档。
所有报告在 CDS《代码审查报告》栏目留档，邮件失败不影响已归档的结果，也不重新扫描代码。
MCP 的 get 与 CLI show --results 可读取已保存的结构化问题、实际覆盖和报告深链；按 nextOffset 分页。
导入报告首个页签直接阅读原文；缺失结构化数据的历史档案在首屏展示归档正文，不把空结果当成零问题。

网页提供“上传源码”和“CDS 项目”两个入口。CDS 项目模式必须主动选择分支，复用已有仓库授权；
开始准备源码时同步远端分支并固定提交 SHA，不包含工作树未提交内容，不执行项目脚本。
MCP list 使用 includeBranches=true 获取当前项目分支，再向 submit 传 branchId；与 zipPath、githubUrl 三选一，ref 仅适用于 GitHub。

## Agent 使用任务调度口令的标准流程

当用户说「给 CDS 加一个定时任务」「每天拉一次数据」「先测试一下这个任务」「把这段 curl 定时跑」时，Agent 必须优先走 `cdscli schedule`，不要手写 curl 调 `/api/scheduled-jobs`。

### 决策流程

1. **先确定项目作用域**：
   - 用户提供 `CDS_PROJECT_ID` / `--project` / 项目名能唯一对应项目时，传 `--project <id>`。
   - 当前环境已有 `CDS_PROJECT_ID` 时可省略 `--project`。
   - 项目不明确时先 `project list`，仍不明确再问用户；不要创建无项目任务。
2. **先解析口令**：
   ```bash
   $CLI schedule parse "每天 02:00 调用 POST /api/statistics/sync" --project <id>
   ```
   用解析结果确认 `schedule.type`、`timeOfDay/intervalMinutes`、`actions` 是否符合用户话术。
3. **涉及真实外部调用或命令时，先测试**：
   ```bash
   $CLI schedule test "手动 执行命令 echo ok" --project <id>
   ```
   `test` 只调用 `/api/scheduled-jobs/check-target`，不创建任务。失败时把失败日志总结给用户，不要继续 create。
4. **创建时默认带 `--test`**：
   ```bash
   $CLI schedule create "每天 03:30 curl -X POST https://old.example/sync" --project <id> --test
   ```
   只有用户明确说「先创建，之后再测」时才允许不带 `--test`。
5. **创建后交付 task id 和验收命令**：
   - 返回 `job.id`。
   - 告知可用 `$CLI schedule run <jobId>` 手动触发一次。
   - 告知可用 `$CLI schedule list --project <id>` 查看。

### 口令格式

调度部分支持：
- `每天 02:00` / `每日 2点` / `daily 02:00`
- `每隔 10 分钟` / `每 2 小时`
- `手动` / `只手动`

动作部分支持：
- `curl -X POST -H 'Content-Type: application/json' -d '{"a":1}' https://example.com/sync`
- `调用 POST /api/statistics/sync`
- `执行命令 node scripts/sync.js`

多个动作可用「然后 / 接着 / 再执行」连接，例如：

```bash
$CLI schedule create "每天 02:00 curl -X POST https://old.example/pull 然后 执行命令 node clean.js" --project <id> --test
```

### 失败处理

- `未识别调度口令`：让用户补充「每天/每隔/手动」之一。
- `未识别执行动作`：让用户提供 `curl`、HTTP URL 或命令脚本。
- `任务动作检测未通过`：不要创建任务；总结 `checks[].result.log/error`，让用户修正 URL、鉴权、命令或服务状态。
- `project_mismatch`：说明当前项目 key 不属于目标项目，让用户在目标项目页重新授权 Agent。

### 安全边界

- 命令动作由 CDS 服务端放进 Docker sandbox 执行，Agent 不要在本地代跑危险命令来“帮用户测试”。
- 含密钥的 curl 可以交给 `schedule test/create`，但最终回复不要复述完整密钥值。
- 用户只说「定时跑这个」但没有调度时间时，不要猜默认每天；先要求补齐调度。

## 认证：页面批准优先

### 已有项目

在目标 git 仓库目录运行：

```bash
$CLI connect --host https://cds.example --project <projectId> --agent <当前 Agent 名称>
```

CLI 免密发起申请，用户在 CDS 右下角批准一次。项目 Key 只由 CLI 接收并写入当前项目
`.cds/credentials.json`，文件权限为 `0600`，同时加入本地 git exclude。密钥禁止出现在对话、
stdout、命令参数、shell profile 或系统环境变量持久配置中。

### 首次创建项目

```bash
$CLI connect --host https://cds.example --new-project --agent <当前 Agent 名称>
```

Agent 自动读取当前 origin 并申报名称和仓库；服务端将一次性 create-only 授权绑定该目标。更改名称或仓库、并发重放及无目标旧申请会被拦截。批准后得到一次性 create-only 授权。`project create` / `onboard` 创建项目成功时，CDS 自动
吊销该授权并返回新项目专属 Key；CLI 静默保存并切换，不打印明文。

### 旧版兼容

已有 `CDS_HOST`、`CDS_PROJECT_KEY`、`AI_ACCESS_KEY` 的进程仍可直接使用。只有用户明确要求
旧流程时才能运行 `cdscli init --legacy-env` 写 `~/.cdsrc`，不得把它作为默认接入方式。

完整认证决策树（含错误码处理） → [reference/auth.md](reference/auth.md)

### 硬性禁令

1. **禁止 `X-Cds-Internal: 1`**：能认证但 Activity 无 AI 标记，违反可观测性。
2. **禁止索要密钥**：默认接入不得让用户把长期 Key 粘进对话或终端命令。
3. **禁止环境侵入**：不得修改 `.bashrc`、`.zshrc`、全局 PATH 或用户主目录技能目录，除非用户明确选择全局安装。
4. **AI 操作必须可见**：所有 AI 请求会出现在 CDS Dashboard 的活动记录中。

## 预览 URL 必须来自 CDS 实际状态

项目安装 CDS 技能包或通过 CDS 右上角快速接入后，必须同时安装并可发现 `preview-url` 技能。缺少该技能视为 CDS 接入未完成。

需要预览地址时，必须调用 `preview-url`，由它执行：

```bash
python3 <当前项目技能根>/cds/cli/cdscli.py --human preview-url
```

当前项目技能根必须按宿主实际安装位置解析，不得假定一定是 `.claude/skills`。`cdscli` 只信任 `/api/branches` 返回的 `previewUrl` / `previewUrls`，不使用分支名、项目名、`previewSlug` 或 `CDS_HOST` 推算 URL。

一个 CDS 实例可能在同一个公开 `previewDomain` 下发布多个真实入口，包括主应用、模型网关控制台和其他声明了 `cds.subdomain` 的独立服务。入口数由实际发布的逻辑服务决定，不等于 `rootDomains` 数量。`rootDomains` 可能包含隐藏、备用或内部域名，API 与 Agent 都不得向用户暴露。命令返回多行时必须全部列出公开入口，不得自行挑选或补写。API 不可用、分支未部署或缺少地址字段时应明确失败，不得退化为本地公式。

这里的“入口”只指用户可操作的 Web 页面，不含 readiness/liveness/health API。路由是否发布由 `cds.subdomain` 决定，是否进入用户入口清单及其名称、落点由 `cds.web-entry-name` / `cds.web-entry-path` 决定；两者禁止混用。`preview-url` 优先消费后端返回的 `previewEntries`，旧响应中混入的健康检查 URL 必须过滤。用户要改入口时，Agent 应维护项目根 `cds-compose.yml`，不要求用户在 Dashboard、分支覆盖和 nginx 配置之间寻找入口设置。

`cds/src/services/preview-slug.ts:computePreviewSlug` 仍是 CDS 后端内部 slug 计算 SSOT，但它不是 Agent 生成公网 URL 的授权。

## env 变量 scope 规则

| scope | 含义 | 注入位置 |
|---|---|---|
| `_global` | 全局变量（所有项目所有分支） | 所有容器 |
| `<projectId>` | 项目级（该项目所有分支） | 该项目容器 |
| `_all` | 仅查询用，不能写 | — |

```bash
$CLI env get --scope <projectId>         # 看项目级
$CLI env set MAP_AI_USER=ai-bot --scope <projectId>
```

`cds-compose.yml` 的 `x-cds-env` 段 = 项目级 scope 的声明源。修改后需要重新 deploy 才生效。

## Agent 操作者身份（渐进兼容）

新版 cdscli 会为每次进程生成随机 `agentSessionId`，并在 Codex 环境可用时附带
`threadId` / `turnId`。服务端为变更请求生成 `requestId` / `operationId`，将这些
字段关联到操作事件、发布记录和 CDS 自更新历史。self update/restart 的 CLI 结果
会直接返回这些关联 ID，复盘时不再依赖临时浏览器响应头。

第一阶段只采集和关联，不参与鉴权：旧版技能没有身份头时仍可使用，并标记为
`identityVersion=0`、`confidence=legacy`；新版声明标记为 `identityVersion=1`、
`confidence=declared`。`declared` 只表示格式有效，不代表身份已由服务端验证。
不得因为缺少身份头拒绝旧客户端，也不得把调用方声明提升成可信身份。

## CDS 服务自更新（改了 cds/ 目录的代码）

触发条件（AI 自动判断）：`git diff --name-only HEAD~1 HEAD | grep ^cds/` 非空。

```bash
$CLI self restart                        # 只重启当前精确 SHA，不拉代码、不切分支
$CLI self update --branch <branch>       # 切 + pull + 重启 CDS 进程
# 重启约 10s，CLI 内部已轮询 /api/config 等恢复
```

用户只说“重启 CDS”时必须使用 `self restart`。只有明确要求把 CDS 更新到某个
分支或提交时才使用 `self update`，禁止再把普通重启隐式升级为代码发布。

共享 CDS 会保留当前运行提交。旧技能在“同 SHA”与“目标包含当前提交”的快进更新
中无需新增参数，仍可直接使用。若目标分支不包含当前提交，服务端会在 checkout
之前拒绝，避免一个 Agent 的分支整体覆盖另一个 Agent 已上线的修复。

正式发布必须先合入当前线上完整提交并验证。仅填写 release 和原因不能证明已有修正被保留，普通自更新仍拒绝非继承发布。确需回滚时显式锁定当前提交并说明原因：

```bash
$CLI self update --branch <branch> \
  --transition-intent rollback \
  --expected-from-sha <当前 self-status headSha> \
  --reason "说明为什么目标分支可以替代当前控制面版本"
```

人工强制更新仍是既有逃生通道；Agent 不得为绕过继承检查自动改用强制更新。
`--transition-intent` 保留 `release` / `rollback` 兼容取值，但 release 不解除普通发布的继承要求。不得把它作为日常兼容参数；
`expected-from-sha` 是乐观锁，生产版本已变化时请求必须失败并重新审计。

自更新、强制同步与仅重启都会先等待其他项目的部署、发布和分支写操作结束（默认 5 分钟）。等待超时取消本次更新与重启，并释放部署入口；原项目继续运行，不自动补发或强制重启。请求 `drainTimeoutMs` / `restartDrainTimeoutMs` 可缩短等待，0 表示忙时立即取消，不能绕过保护。取消发生在切换代码和前端产物之前，历史记录为“已中止”；等其他操作结束后重新执行原命令。

注意：self-update 期间 CDS API 短暂不可用（~10s），CDS 内部 state.json 迁移逻辑会自动跑。

## 维护者通道（仅 inernoro/prd_agent 仓库所有者）

> 改 `cli/cdscli.py` / 改 reference / bump VERSION / push —— 你就是技能源头，直接编辑 `.claude/skills/cds/` 即可。**没有发布流程**。

触发词（严格）：`/cds-sync` / `/cds-sync-skill` / "帮我同步 cds 技能" / `cdscli sync-from-cds`。

完整维护者工作流（drift 扫描 → plan-first → 改三文件 → 自检 → changelog）→ [reference/maintainer.md](reference/maintainer.md)

## 反馈缺口给上游 CDS 团队

发现 cdscli / CDS 服务端 bug 或能力缺口（issue #544 / #550 / #551 / #552 类）→ 走 `/audit`（`auto-fix-issues` 技能）协议，**不要**在 CDS skill 内部塞反馈逻辑。

## 参考索引（按需加载）

| 文件 | 何时读 |
|---|---|
| [reference/api.md](reference/api.md) | 直接调 CDS REST API（CLI 未覆盖场景）— 被 `cds-project-scan` / `cds-deploy-pipeline` 共享引用 |
| [reference/auth.md](reference/auth.md) | 401 / 403 / 双层认证决策树 |
| [reference/scan.md](reference/scan.md) | 扫描规则、compose YAML 契约（`cds-project-scan` 详读） |
| [reference/smoke.md](reference/smoke.md) | 分层冒烟策略（`cds-deploy-pipeline` 详读） |
| [reference/diagnose.md](reference/diagnose.md) | 容器日志 → 根因决策树（`cds-deploy-pipeline` 详读） |
| [reference/drop-in.md](reference/drop-in.md) | 新项目接入完整步骤 + 常见问题 |
| [reference/acceptance-reports.md](reference/acceptance-reports.md) | 验收技能分派、CDS 取证适配与归档存储接口；标准生成和准入由 create-visual-test-to-kb 负责 |
| [reference/maintainer.md](reference/maintainer.md) | 仅 CDS 仓库所有者读 |

## 跨技能依赖

```
       cds (core / dispatcher)
        │
        │ hosts: cli/cdscli.py + reference/*.md
        ▼
   ┌────┴────┐
   │         │
cds-project-scan   cds-deploy-pipeline
 (冷：接入)         (热：调试)
```

两个子技能都从 `../cds/cli/cdscli.py` 引用 CLI，**不维护各自的拷贝**。

## 部署项目的资产存储（prd-agent 图片/报告，2026-06-22）

prd-agent 的图片/验收报告走后端 `IAssetStorage`，由**项目环境变量** `ASSETS_PROVIDER` 选择后端（在「项目环境变量」里配，不是 CDS 全局变量）：

- 未配任何云凭据（典型 CDS 预览）→ 后端自动 **auto 回退 local**，图片存到容器内 `ASSETS_LOCAL_DIR`（默认 `{ContentRoot}/data/assets`），**无需任何配置即可正常传图**（修复"无云凭据实例传图直接失败"）。
- 生产/需云端持久 → 配 `ASSETS_PROVIDER=cloudflareR2` + `R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET`（R2 后端已内置，S3 兼容），或 `tencentCos` + `TENCENT_COS_*`。
- local 是占位/兜底，容器重建即丢；要持久化预览图片可挂卷到 `ASSETS_LOCAL_DIR` 或直接配 R2。

详见 `.claude/skills/create-visual-test-to-kb/SKILL.md`「报告图片与资产存储」。

### 凭据恢复

重新运行原 connect 口令即可。CLI 保存无密钥的项目定位信息，丢失 credentials.json 时仍连接原项目，不重复创建。有效凭据直接复用；已有有效身份和授权可补发丢失凭据；失效或撤销的项目凭据需要在原审批入口重新批准一次。网络故障不触发新建或覆盖凭据。整个流程不要求新人查项目编号、复制密钥或修改终端配置。

同一目标的原口令会恢复原项目；明确指定不同项目名称、slug 或仓库的新建任务仍申请新目标，不得默默复用旧项目。旧连接的定位信息由 CLI 从已授权项目自动补齐，不要求新人填写。

账号或主体停用、原项目整体授权被收回时，同一命令只读等待管理员在现有「用户管理」或「项目授权」页面恢复原权限，恢复后自动继续。等待期间不创建匿名申请、不补发凭据、不改写本地文件。管理员恢复账号不复活已明确撤销的密钥；这种密钥仍沿原项目批准更新。已知用户身份失效时不能降级匿名。等待超时保留原连接，恢复后重跑原命令，无需新人查编号或复制密钥。


## 首次账号与整份身份恢复

普通账号沿现有用户管理开通，由管理员授予原项目。已有仓库首次接入且没有本地身份时，connect自动把设备申请放到用户管理；管理员核对原账号与原项目后批准，用户身份及项目凭据自动0600落地，新人不复制密钥。

用户身份与整个.cds连接同时丢失时，Agent在原仓库执行 `connect --host <原CDS主机> --recover`，自动读取origin；不能改用new-project猜建副本。仍有有效用户身份则自动从其授权项目查找唯一仓库；停用或撤权等待原权限恢复，已知失效身份不降匿名。多个匹配项目由管理员明确选择。网络/保存中断保留私有恢复票据，原命令继续同一申请，不反复批准；全部文件保存后确认领取。

设备恢复签发的用户身份仅可发现和补回此次原项目，不能建项目、不能借原账号其他授权扩范围。管理员在用户管理核对历史匿名凭据的确切项目、凭据ID与原账号后确认归属；不按Agent名推断，不批量迁移。已撤销和已有归属不可认领，认领保留原范围并立即受账号/项目撤权约束。原授权对话框支持搜索和定位原项目，仅过滤展示，不自动恢复勾选。

历史结果首次整理可能返回 `result: null, resultLoading: true`；继续查询同一任务直至返回分页结果。该过程只读取已有问题，不恢复收费审查。

## 代码审查用户 Key

在“更多选项”可选择自己的 OpenAI、Anthropic、OpenRouter 或 DeepSeek Key；失败不回退平台额度。CLI 使用 `code-review submit --user-key-env <本地变量名> --provider <供应商> --model <模型> --token-limit <保护额度>`，不要把明文 Key 放在参数或报告中。`code-review usage <任务ID>` 查询网关同账本用量；只有 Key 所有者可以继续重试消费。MCP 的 `userKey.apiKeyEnv` 同样只填写本地环境变量名。

## DTS 数据同步

通过 `cdscli dts --help` 查询连接、比较、启动、状态和账号规则；沿用当前项目授权。
先比较，保留返回的计划编号，以稳定的 `--idempotency-key` 启动；结果不明时查询原任务，不重新提交。
`completed` 表示原生传输结束且独立对账通过。暂停或取消必须等待服务确认，续传会重新比较。
业务数据默认只追加；账号规则每 5 秒发现缺失账号，每天上海时间 03:00 校准管理员批准的资料字段。
连接由系统所有者登记，只引用已有项目私密配置，不把数据库密码交给 Agent 或放入同步文件。
MCP 使用同一项目凭据，运行 `node cds/mcp/src/server.mjs --dts`；工具目录以服务端能力接口为准。
当前以 SeaTunnel 3.0.0 处理 MongoDB 与受控 JDBC 传输；Redis 由固定版本 RedisShake 保留数据类型与绝对过期时间，RabbitMQ 首轮只追加持久拓扑、不消费消息。SQL 目标须绑定可核实容量的托管服务；各服务的具体版本、字段和写入能力以服务端返回为准，未开放的范围不能当作已支持。
