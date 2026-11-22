# CDS 设计接入

从 CDS「设计」页的「接入 Agent」复制标准口令，再交办「请按说明接入并提交当前设计稿」。接入链接使用 `target=existing`、项目 ID、`skills=cds` 和 `mission=design-publish`。交付者和接收者通过项目里的私有稿件、版本和回执协作。

## 开工前

1. 在当前工作区用 `cdscli setup-check --host <CDS 地址> --project <项目 ID> --design-access publish` 自检。设计发布用 `publish`，实施反馈用 `feedback`，读取资料用 `read`。缺权限时，保持同一项目和角色，用 `cdscli connect --host <CDS 地址> --project <项目 ID> --design-access publish --agent <智能体名称>` 发起申请。系统所有者到「项目」页右下角的「授权申请」核对项目和角色后批准。智能体自动领取凭据，保存在本工作区，并再次自检。等待中断时继续原命令。MCP 从同一工作区以 `node <CDS 源码>/cds/mcp/src/server.mjs --design` 启动。
2. 调 `cds_design_read`，传 `{"view":"intake"}`。回读项目、协议版本、稿件 ID、接入标识、已登记的稿件目录、最新版本、续版权限、待处理反馈数量和框架。CLI 的同等入口是 `cdscli design intake`。接口为 `GET /api/projects/:projectId/design/intake`，当前协议版本为 `1`。
3. 先从清单定位与用户目标有关的稿件。按 `designId` 与 `latestVersion` 固定原稿，按框架 ID 与版本读取规则。目标项目、原稿、基线、改动范围或权限依然不明确时，在修改和发布前一次提清问题。已读到的信息直接采用。不同项目或已存在的历史相似稿件均按实际 ID 与授权范围处理。

同一工作区的设计凭据到期时，使用原接入口令续接。CDS 会核对原凭据，获批后保留原稿作者身份。

## 决定写入动作

| 意图 | `cds_design_publish` 的字段 | CDS 中的结果 |
| --- | --- | --- |
| 新稿 | `intent=create`，稳定 `designKey`，独立稿件子目录 | CDS 分配稿件 ID，从 V1 开始 |
| 同稿修订 | `intent=revise`，现有 `designId`，读回的 `expectedVersion` | 原稿件新增一版 |
| 新模块的首份稿 | `intent=create`，采用新模块段的 `designKey`，独立稿件子目录 | 新模块的独立稿件 |

`designKey` 使用 `module/draft`。两段用稳定的小写字母、数字和连字符，标题、文件名和换智能体都沿用原稿件接入标识。模块下可以有不同的稿件标识。`design.json.group` 用于页面展示分组。旧稿没有接入标识时，先用原 ID 续版。如已确认长期标识，可在一次已授权的续版中同时绑定。接口对项目内相同标识或已登记目录拒绝重复新建，过期基线须回读新版。已有稿件后，未声明意图的旧 Agent 可按原 ID 续版，新稿使用明确的创建动作。

基线冲突先回读对应稿件的新版本和变更，再确认希望继续的修订。发布权取决于该稿件的发布身份，以 `canRevise` 为准。项目读取权限让接收者查看版本和回执。

## 提交与交付

- `design.json.project` 等于绑定的项目 ID。保留适用的固定框架和画面编号，包含 `design.json`、`思路.md` 与清单声明的单文件 HTML。标准新建由服务器分配 ID，清单和请求均省略稿件 ID。续版可沿用清单中的同稿 ID。
- 在工作区仅提交获授权的稿件子目录。使用 `cdscli design publish --private --dir <稿件目录>`，按新稿或续版附上相应参数。提交保留在本地，稿件及归档摘要存入已获授权的 CDS 项目。
- MCP 通过 `cds_design_publish` 传 `sourceMode: "private"`、`zipPath`、本地 `sourceCommit`、仓库相对 `sourcePath`、`requestId` 和意图字段。用本地提交导出稿件目录的 ZIP，放在项目工作区内，避开 `.cds` 和 `.git`，大小上限 4 MiB。HTTP 使用同一项目的 `/design/packages`，内容为 ZIP，其余字段通过查询参数传递。
- 已获授权并已存在于项目 Git 的材料可以沿用 Git 核验方式。CDS 分别显示 Git 核验证据和私有归档。
- 在 `note` 记录原版、改动画面、原因和待核验项。发布后按回执的 `designId` 与 `version` 回读，核对项目、源提交和归档摘要。响应不确定时以原 `requestId`、来源、意图和稿件内容重试。设计接入按 ZIP 内的文件内容识别重试。接收者从同一项目回读固定的新旧版，定位差异后复拍受影响画面。缺实拍仍标待核验。


## 完整交付资料

- 原型、清单、设计思路、交付说明、开发与设计文档、可重建源码、框架草案、截图和自检可一起提交。声明过的资料用包内相对路径，可用中文。版本会保留原 ZIP，以及每份文件的路径、类型、大小、摘要和可识别的文档章节。未知类型的附件也可按版本下载。附件内容是工作材料。
- `design.json` 可用 `docs` 列出设计、开发和决策文档，`source` 指向用于重建的源码，`frameworkDraft` 指向框架草案，`prototypeVersion`、`date`、`notes` 补充作者交付说明。CDS 自己记录稿件版本和发布时间。
- 画面共用入口时，可用 `entryActions` 依次选择原型内可见控件，用 `entryReadySelector` 声明原型状态就绪标志。它们随版保留。框架自动测量切换状态后等待对应的就绪标志，缺少状态证据时记录为待验证。`impl` 和 `readySelector` 用于打开与验收对应的实现页。画面与声明的行为不符时，先查看该版材料并提反馈。
- `cds_design_read` 的 `delivery` 读取固定版资料与验收缺项，用 `{view:"file",id,version,path}` 原文分段回读。接着传响应的 `nextOffset`，已到结尾时它为空。可以从稿件的「交付」下载原包或单个文件。继续使用历史版本的来源记录、原型、思路及验收数据。
- 作者的原型自检负责记录原型状态。实现路径、实现分支的验收证据及真人签收继续由各自的入口独立记录。共用入口不明确、缺实拍、缺实现地址或缺探针时，在反馈中说明要补的内容和复核方法。

## 双向反馈

1. 实现方先读 `intake`、固定版 `delivery` 和已有 `feedback`。用 `cds_design_feedback` 的 `feedback.create` 记录复用建议、实施做法、需求缺漏、落地约束或验收建议。提供稿件、版本、分类、标题、理由、改动依据和可核对证据。对整份稿件或特定画面都可以登记。
2. 设计方读同一线程，调用 `feedback.reply` 回复。需要改稿时按原稿 ID 和最新基线发布，再在回复的 `revision` 引用自己发布的实际版号。只需解释、确认约束或说明方案取舍时，可以直接回复。
3. 原反馈者回读新版和同一线程，按证据验证。用 `feedback.resolve` 的 `close` 或 `reopen` 加说明保留复核结果。项目管理者也可处理。发布、反馈、实际做法验收和人类签收各自按项目权限执行。重试沿用原请求编号。

HTTP 与 MCP 共用项目级设计接口。反馈写入走 `POST /api/projects/:projectId/design/feedback`。固定版本资料在工作区回读中，原文可以用 `GET /api/projects/:projectId/design/artifacts/:artifactId?view=text` 分段读取。
