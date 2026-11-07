---
name: cds
metadata:
  version: 0.20.2
description: CDS (Cloud Dev Space) core skill — provides cross-Agent, project-scoped onboarding without copying keys or modifying shell profiles, hosts the canonical cdscli Python CLI, checks current-site load and tells users about standby sites with host-isolated credentials, manages CDS authentication and project access, owns CDS service self-update, exposes managed deployment runs and versions, requires the companion preview-url skill to read actual preview URLs from CDS, and dispatches scanning or deployment work to the matching CDS skill. Activates for CDS onboarding, connect, authentication, deployment status, versions, rollback, self-update, preview URLs, or the bare word CDS when intent is unclear.
---

# CDS — 核心技能：安全接入 / cdscli / 托管交付 / self-update / 分诊器

> **版本**：v0.20.2 | **状态**：已落地 | **触发**：`/cds`、`/cds-auth`、"接入 CDS"、"CDS 授权"、"部署记录"、"版本回滚"、"cds 自更新"、"预览地址"、"数据库操作"、"代码审查报告"

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

## 主备 CDS：先发现、独立接入、明确选择

### 负载偏高时主动告知用户

开始部署、拉取或创建分支前，先检查 `cdscli instance list`。优先读项目根目录
`cds-instances.json`；没有项目目录时使用技能包自带的公开地址快照，首次安装可直接离线发现主备。
可用 `instance sync` 从支持该接口的当前站点刷新项目目录；旧站点不支持时保留包内快照，
不能把目录查询失败解释为授权失败。再执行 `cdscli instance recommend`。它只查询当前站点
`/api/host-stats`：CPU 一分钟负载占核心数比例达到 80% 判为 `high`；未达到为 `normal`；
超时、权限失败、维护 503、重定向或响应缺字段为 `unknown`，不能据此宣称过载。

- 返回 `high` 时，**必须在对话里通知用户**当前站点负载偏高、备用名称和访问地址，并明确“不同站点密钥不同，备用需要独立授权”。仅在工具日志里留下提示不算通知。
- 用户尚未选择时，先说明“可继续当前站点，也可使用备用站点”，等选择后再发起部署；已有明确站点选择则沿用，不重复索要确认。
- 返回 `alternatives[].authorization=required` 时，在目标站点使用 `instance connect` 走页面批准；不让用户在对话中复制密钥，不把当前 Key、项目 ID 或分支 ID 填到备用。
- `stored-not-verified` 仅表示本地有目标项目授权，仍需 `instance check` 校验。备用健康状态未被检查，不能说“备用已就绪”。
- 用户选择备用后按下节的独立接入与选择流程执行；选择继续当前站点则保留原连接。
- `unknown` 时说明负载未确认，可给出 `instance list` 中的备用入口，不把网络失败归因为负载。

常用部署命令还会在已登记的多站点目录下自动检查一次，并在高负载时输出 stderr 提示和
JSON `notices[code=cds-load-high]`。这是兜底提示，原命令仍在原站点执行；Agent 必须提前运行
只读 `instance recommend` 才能在写操作前给用户选择。CLI 不自动切换，不跨站点重放请求。
负载检查不访问备用站点，也不向它发送任何凭据；结果与脱敏响应证据按次保存到
`.cds/instance-load-checks/`，正常与失败均可追溯。


用户说“用备用 CDS 继续部署”时，先离线运行 `cdscli instance list`，读取仓库根目录
`cds-instances.json`；没有目录且主站可用时可运行 `cdscli instance sync` 同步公共地址。
技能包包含与仓库公开目录一致的地址快照；项目根目录可覆盖，目录只描述地址与角色，不表示健康或授权。
主站故障时直接使用已保存的项目目录或包内快照，不依赖故障主站重新下发地址。

- `cdscli instance connect standby --project <目标项目ID> --agent Codex`：申请目标项目独立授权，保留原实例授权。
- 目标还没有项目：使用 `instance connect standby --new-project --create-project <名称> --git-url <仓库地址>`，然后走冷路径完成项目接入。
- `cdscli instance check standby`：校验目标项目授权、项目 ID 和仓库绑定；失败不选择、不部署。
- `cdscli instance use standby`：校验后保存当前仓库的默认实例；用 `instance use primary` 切回。
- `cdscli --instance standby <原有命令>`：仅本次使用目标实例，覆盖继承的主用环境凭据并先校验目标项目，不改变默认选择。

实例目录只包含公开名称、角色和站点根地址，不能放 Key。独立授权保存在本地
`.cds/instance-credentials.json`；默认选择保存在 `.cds/active-instance.json`，均排除 Git、权限 0600。
旧 `.cds/credentials.json` 在未选择实例时继续兼容。检查证据按次保存到本地
`.cds/instance-checks/`，只保留受控项目身份字段和判定，不保存环境变量或密钥。

选择备用后，重新读取该实例的项目、profile、分支和预览地址；不要复用主用的分支 ID。
确认目标的环境变量、外部依赖和 CI 预构建模式，再走 `cds-deploy-pipeline` 发起新部署。
遇到超时不自动向另一实例重放写请求，先确认原任务是否已被接受。
这一版不迁移数据库、不接管流量、不承诺后台 Worker 能安全双跑。

用户入口：控制台顶部“主备 CDS”；断线提示展开后也能打开入口。网页切换进入目标项目列表，
需要独立登录。可提前“下载备用入口”保存地址；标签页目录快照仅用于故障导航，不代表健康状态。

### 备用继续部署：现有分支的完整验收路径

用户明确选择备用后，沿用已批准的目标项目授权；没有目标授权才运行 `instance connect`。
不重新申请已保存且校验有效的授权，不复制当前站点 Key，不把主站的项目或分支 ID 当作备用 ID。

1. `instance check standby` → `instance use standby` → `auth inspect --strict`：校验备用项目与仓库，保存选择并确认后续命令使用备用独立授权。继承的主站环境 Key 必须被清除。
2. `project show <备用项目ID>` → `profile list` → `branch list`：从备用实际返回结果选择现有分支，核对就绪路径、依赖与预构建模式。不要创建同名副本或改项目级默认来代替分支选择。
3. 固定完整 40 位目标提交，确认同提交 CI 和预构建产物成功；已有同提交的成功产物可以复用，不以另一提交的 CI 代替。
4. `branch deploy <备用实际分支ID> --commit <完整SHA> --timeout 600`：只向备用发起一次部署。记录返回的 `deploymentRunId`，用 `deployment-run show <runId>` 跟踪本次运行；超时先查该运行，不能自动跨站重放或重复部署。
5. `branch status <备用实际分支ID>`：本次运行终态为 running，`runningCommitSha` 与 `targetCommitSha` 等于目标提交，`deployRuntime.prebuilt=true`、`sourceProfiles=0`、`drift.hasDrift=false`。不能只凭原有 BranchEntry 显示 running 宣称本次部署成功。
6. `cdscli --human preview-url` 读取实际入口，按目标 profile 配置的就绪路径检查，并访问公网 HTML 及实际 JS/CSS。核对部署前后的主备控制台可用性；正式控制面、全局代理、共享依赖和其他项目不属于本次验收分支的修改范围。

使用受限 CDS Self Preview 时，原配置就绪路径是 `/api/instance-mode`；它不具备宿主 Docker 权限，
通用 `/healthz` 的既有异常应如实记录，不能修改探针掩盖，也不能将该例推广成所有项目的默认。
验收记录只保存目标站点、请求 ID、部署运行、提交和“目标 Key 匹配 / 主站 Key 未携带”等判定，
不能保存真实 Key、原始认证头或含密钥的完整环境。切换不迁移数据库，也不接管业务流量。

接入自检兼容性：`setup-check` 保留既有能力；仅在目标提供 `/api/agent/setup.json` 协议时使用。
旧站点缺少该协议时，按上面的 `auth inspect`、`instance check` 和真实项目查询验证，
不能因为协议 404 清除凭据、重复申请授权或拿另一站点 Key 兜底。

## cdscli — 唯一 CLI 入口（其他两个技能也走它）

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

# CDS 服务自更新（仅改 cds/ 代码时）
$CLI self branches                       # 看 CDS 自身能切到哪些分支
$CLI self status                         # 看当前版本、提交和运行状态
$CLI self update --branch <branch>       # 切 + pull + 重启 CDS 进程

# 验收报告 / 视觉取证（CDS 自托管 HTML/Markdown，登录态门控，可按项目/文件夹归类）
$CLI report-folder create --name "2026-06 验收"        # 建文件夹（可 --project）
$CLI report create --title "CDS · X · 验收报告" --html-file r.html --folder <fid> [--project <id>]
$CLI report list --folder <fid>                        # 列出（可 --project / --folder）
$CLI report deeplink <reportId>                        # 打印 /reports?folder=&report= 直达深链
$CLI report-folder list [--project <id>]
# 视觉取证全流程（穿 agent 代理的浏览器取证 + 组装 HTML 入库）见 reference/acceptance-reports.md +
# cli/acceptance/（proxyroute.mjs / cds-harness.mjs / build_report_html.py / driver.template.mjs）
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

CDS 的通用 Agent 通道仍为“技能 + cdscli + REST”。代码审查另提供项目级本地 stdio
桥接，安装与配置见仓库 `cds/mcp/README.md`；不提供远程 HTTP MCP 或通用部署工具。

已提供的四个工具：`cds_code_review_submit`、`cds_code_review_get`、
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

## 代码审查与报告上传

```bash
$CLI code-review submit --github https://github.com/owner/repo --ref main --project <id>
$CLI code-review submit --zip-file source.zip --exclude 'vendor/**' --project <id>
$CLI code-review submit --zip-file source.zip --email owner@example.com --idempotency-key <same-submission>
$CLI code-review list --project <id>
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
导入报告或不能完整还原的历史档案保留原文，不把空的结构化结果当成零问题。

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
| [reference/acceptance-reports.md](reference/acceptance-reports.md) | 视觉取证 → CDS 自托管验收报告 → 项目/文件夹归类 → 直达深链（含穿 agent 代理的浏览器取证解法） |
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
