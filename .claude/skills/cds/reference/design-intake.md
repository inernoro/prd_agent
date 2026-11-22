# CDS 设计接入

从 CDS「设计」页的「接入 Agent」复制标准口令，再交办「请按说明接入并提交当前设计稿」。接入链接使用 `target=existing`、项目 ID、`skills=cds` 和 `mission=design-publish`。交付者和接收者通过项目里的私有稿件、版本和回执协作。

## 开工前

1. 在当前工作区用 `cdscli setup-check --host <CDS 地址> --project <项目 ID> --design-access publish` 自检。设计发布用 `publish`，实施反馈用 `feedback`，读取资料用 `read`。缺权限时，保持同一项目和角色，用 `cdscli connect --host <CDS 地址> --project <项目 ID> --design-access publish --agent <智能体名称>` 发起申请。系统所有者到「项目」页右下角的「授权申请」核对项目和角色后批准。智能体自动领取凭据，保存在本工作区，并再次自检。等待中断时继续原命令。MCP 从同一工作区以 `node <CDS 源码>/cds/mcp/src/server.mjs --design` 启动。
2. 调 `cds_design_read`，传 `{"view":"intake"}`。核对项目、框架和稿件，并从 `requirements` 按约定的 `designKey` 读取已确认需求原文、来源计划和对话。CLI 的同等入口是 `cdscli design intake`。接口为 `GET /api/projects/:projectId/design/intake`，当前协议版本为 `1`。已授权的设计凭据可直接读取项目中交给设计的单条需求，工程规划接口继续按现有范围控制。

交给设计的需求以系统所有者确认的原计划为来源。接入清单同时提供 `designs`。相同标识已有稿件时用原稿 ID 和读到的最新版续版，尚未有稿件时才用该标识发布首稿。指定的需求查不到时先核对项目与标识，请项目管理者从原计划交给设计。开工前有问题时，用 `cds_design_feedback` 的 `brief.reply`，提供 `designKey`、回读的 `expectedVersion`（即需求的 `planVersion`）、`requestId` 与 `body`。CLI 用 `cdscli design brief-reply <designKey> --expected-version <planVersion> --body <说明>`。服务端把澄清与需求原文一起回读，人和设计智能体可在同一处回复。
3. 先从清单定位与用户目标有关的稿件。按 `designId` 与 `latestVersion` 固定原稿，按框架 ID 与版本读取规则。目标项目、原稿、基线、改动范围或权限依然不明确时，在修改和发布前一次提清问题。已读到的信息直接采用。不同项目或已存在的历史相似稿件均按实际 ID 与授权范围处理。

同一工作区的设计凭据到期时，使用原接入口令续接。CDS 会核对原凭据，获批后保留原稿作者身份。

技能需要更新时，从接入说明提供的 `/api/skills/cds-pack/download` 匿名下载归档。用本机工具解压并核对 manifest，将完整五技能装到当前工作区，再以原来的设计授权自检。Windows 检出的技能文本只有 CRLF 与 LF 的差异时可以通过自检。

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
- 在工作区仅提交获授权的稿件子目录。若没有 Git 作者配置，可为本次提交指定智能体自己的作者身份。CDS 根据获授权的身份记录发布者。使用 `cdscli design publish --private --dir <稿件目录>`，按新稿或续版附上相应参数。提交保留在本地，稿件及归档摘要存入已获授权的 CDS 项目。
- MCP 通过 `cds_design_publish` 传 `sourceMode: "private"`、`zipPath`、本地 `sourceCommit`、仓库相对 `sourcePath`、`requestId` 和意图字段。用本地提交导出稿件目录的 ZIP，放在项目工作区内，避开 `.cds` 和 `.git`，大小上限 4 MiB。HTTP 使用同一项目的 `/design/packages`，内容为 ZIP，其余字段通过查询参数传递。
- 已获授权并已存在于项目 Git 的材料可以沿用 Git 核验方式。CDS 分别显示 Git 核验证据和私有归档。
- 在 `note` 记录原版、改动画面、原因和待核验项。发布后按回执的 `designId` 与 `version` 回读，核对项目、源提交和归档摘要。响应不确定时以原 `requestId`、来源、意图和稿件内容重试。设计接入按 ZIP 内的文件内容识别重试。接收者从同一项目回读固定的新旧版，定位差异后复拍受影响画面。缺实拍仍标待核验。
- 私有发布的版本摘要 `sha256` 来自上传 ZIP 的原始字节。清单同时保留每个文件的 `sha256` 和原型的 `prototypeSha256`，用于分别核对交付文件和原型。


## 完整交付资料

- 原型、清单、设计思路、交付说明、开发与设计文档、可重建源码、框架草案、截图和自检可一起提交。声明过的资料用包内相对路径，可用中文。版本会保留原 ZIP，以及每份文件的路径、类型、大小、摘要和可识别的文档章节。未知类型的附件也可按版本下载。附件内容是工作材料。
- `design.json` 可用 `docs` 列出设计、开发和决策文档，`source` 指向用于重建的源码，`frameworkDraft` 指向框架草案，`prototypeVersion`、`date`、`notes` 补充作者交付说明。CDS 自己记录稿件版本和发布时间。
- 画面共用入口时，可用 `entryActions` 依次选择原型内可见控件，用 `entryReadySelector` 声明原型状态就绪标志。它们随版保留。框架自动测量切换状态后等待对应的就绪标志，缺少状态证据时记录为待验证。`impl` 和 `readySelector` 用于打开与验收对应的实现页。画面与声明的行为不符时，先查看该版材料并提反馈。
- `cds_design_read` 的 `delivery` 读取固定版资料与验收缺项，用 `{view:"file",id,version,path}` 原文分段回读。接着传响应的 `nextOffset`，已到结尾时它为空。可以从稿件的「交付」下载原包或单个文件。继续使用历史版本的来源记录、原型、思路及验收数据。
- 作者的原型自检负责记录原型状态。实现路径、实现分支的验收证据及真人签收继续由各自的入口独立记录。共用入口不明确、缺实拍、缺实现地址或缺探针时，在反馈中说明要补的内容和复核方法。

## 双向反馈

1. 实现方先读 `intake`、固定版 `delivery` 和已有 `feedback`。用 `cds_design_feedback` 的 `feedback.create` 记录复用建议、实施做法、需求缺漏、落地约束或验收建议。提供稿件、版本、分类、标题、理由、改动依据和可核对证据。对整份稿件或特定画面都可以登记。
2. 设计方通过 `cdscli design feedback <稿件编号>`（可选择版本，仍含未关闭的旧版反馈）读同一线程，调用 `design feedback-reply` 或 MCP `feedback.reply` 回复。需要改稿时按原稿 ID 和最新基线发布，再在回复的 `revision` 引用自己发布的实际版号。只需解释、确认约束或说明方案取舍时，可以直接回复。
3. 原反馈者回读新版和同一线程，按证据验证。用 `feedback.resolve` 的 `close` 或 `reopen` 加说明保留复核结果。项目管理者也可处理。发布、反馈、实际做法验收和人类签收各自按项目权限执行。重试沿用原请求编号。

针对交付文件提反馈时，从该版本的 `delivery.files` 读取完整 `path`，用 `feedback.create` 的 `filePath` 关联。服务端核对文件属于所选稿件版本。

需要提交对照图时，用 `feedback.attach` 提供原稿 ID、反馈 ID、图片说明、请求编号与工作区内 `imagePath`。CLI 用 `cdscli design attach-evidence <designId> --feedback-id <feedbackId> --title <说明> --file <图片.png>`。要标明截图来源时，加 `--version`、`--screen`、`--slot`，对应 MCP 的 `version`、`screenId`、`slot`。回读 `attachments` 核对回执、版本和截图。已授权成员可查看交付页或读取 `GET /api/projects/:projectId/design/artifacts/:artifactId`。每张 PNG 上限 1.5 MiB。逐规则的验收结论仍由做法验收记录。

正文走 `POST /api/projects/:projectId/design/feedback`，PNG 走 `POST /api/projects/:projectId/design/feedback/attachments`。固定版本资料可用 `GET /api/projects/:projectId/design/artifacts/:artifactId?view=text` 分段读取。

## 固定框架版本

使用 `cdscli design scaffold --framework <框架ID> --framework-version <版本> --dir <新目录> --title <稿件名>` 复用该版规范。框架初衷可随稿件的 `spec/charter.json` 一并提交，或在框架导入时提供同样的 `charter` 对象。字段包括 `status`、`intent`、`problems`、`nonGoals`、`scope` 和 `owner`。可附示意稿 `example`、规则来源 `ruleSources` 和模块差异 `moduleDiffs`。

从实施基线提取时，先用 `cdscli design extract <稿件ID> --into <框架ID>` 查看候选。采用时把预览里的 `sourceVersion` 传给 `--version`，把 `expectedVersion` 传给 `--expected-version`，并指定要采用的 `--apply` 项。目标框架在用时，用 `--resolve rules=keep` 或 `--resolve tokens=adopt` 逐项确认。

## 按正式宿主预览

`cdscli design preview --dir <稿件目录> --screen <画面编号> --theme dark` 在环回端口打印预览地址。打开地址即可检查就绪状态，控制台和终端同时显示错误摘要。命令只读取稿件目录中的入口，不需要登录。桌面与手机版依照画面声明分别使用 1280×800 和 375×812。

正式画布和本机预览都以 `sandbox="allow-scripts"` 和相同的响应头 CSP 运行原型。原型使用不透明源，不能访问父页、网络接口、浏览器存储或外部资源。子画面用内联 `srcdoc`，把状态存到原型内存中；图片和字体按响应头允许的类型内联。需要自动进入的画面在 `design.json` 声明 `entryActions` 和唯一可见的 `entryReadySelector`，默认等待 8000 毫秒，可为单屏在 `entryTimeoutMs` 指定 500–15000 毫秒。提交前逐项检查两种主题、375 真机宽度以及 Windows 100%、125%、150% 等效视口，并保留对照证据。

## 从系统和模块接入

先读同一项目的 `cdscli design intake` 或 MCP `cds_design_read` 的 `intake`。使用 `systems[].modules` 选择系统和模块。交接需求与原稿会附上 `scope`，已有的 `designKey`、稿件编号和来源路径仍可继续用。若 `design.json` 声明归属，可填 `scope: {"systemId":"<系统>","moduleId":"<模块>","related":[{"systemId":"<系统>","moduleId":"<受影响模块>"}]}`。服务端会校验所有归属在当前项目登记。同一稿件的续版沿用主归属，需调整时由项目管理者先登记变更。

稿件未指定框架时沿用原稿框架；新稿依次查模块和系统的默认框架，使用 `intake.frameworks[].adoptedVersion` 对应的可用版本并在发布时锁定。设计方先读该版框架的范围、示意稿和源码，属于模块的局部差异写在已有稿件反馈或接入需求线程。

首稿可以先用 `cdscli design brief-claim <接入标识> --expected-version <计划版号>` 认领，也可调用 MCP 的 `brief.claim`。接入清单回读实际出稿人，写作权限沿用现有项目授权。原出稿人和项目管理者可在未发布首稿时用 `design brief-release` 或 `brief.release` 交回。需要澄清的事项继续回复同一个需求线程。
