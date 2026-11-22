# CDS 设计接入

通用交办提示是「请阅读 CDS 设计接入并按规范提交」。交付者和接收者通过项目里的私有稿件、版本和回执协作。

## 开工前

1. 使用已授权项目环境的 `CDS_HOST`、`CDS_PROJECT_ID` 和 `CDS_PROJECT_KEY`，在项目 Git 工作区运行 `cdscli init --yes`。设计发布者需要该项目的 `designAccess: publish`，接收方可用 `read`。MCP 从同一工作区以 `node <CDS 源码>/cds/mcp/src/server.mjs --design` 启动。
2. 调 `cds_design_read`，传 `{"view":"intake"}`。回读项目、协议版本、稿件 ID、接入标识、经 Git 核验的目录、最新版本、续版权限和框架。CLI 的同等入口是 `cdscli design intake`。接口为 `GET /api/projects/:projectId/design/intake`，当前协议版本为 `1`。
3. 先从清单定位与用户目标有关的稿件。按 `designId` 与 `latestVersion` 固定原稿，按框架 ID 与版本读取规则。目标项目、原稿、基线、改动范围或权限依然不明确时，在修改和发布前一次提清问题。已读到的信息直接采用。不同项目或已存在的历史相似稿件均按实际 ID 与授权范围处理。

## 决定写入动作

| 意图 | `cds_design_publish` 的字段 | CDS 中的结果 |
| --- | --- | --- |
| 新稿 | `intent=create`，稳定 `designKey`，独立 Git 目录 | CDS 分配稿件 ID，从 V1 开始 |
| 同稿修订 | `intent=revise`，现有 `designId`，读回的 `expectedVersion` | 原稿件新增一版 |
| 新模块的首份稿 | `intent=create`，采用新模块段的 `designKey`，独立 Git 目录 | 新模块的独立稿件 |

`designKey` 使用 `module/draft`。两段用稳定的小写字母、数字和连字符，标题、文件名和换智能体都沿用原稿件接入标识。模块下可以有不同的稿件标识。`design.json.group` 用于页面展示分组。旧稿没有接入标识时，先用原 ID 续版。如已确认长期标识，可在一次已授权的续版中同时绑定。接口对项目内相同标识或已核验目录拒绝重复新建，过期基线须回读新版。已有稿件后，未声明意图的旧 Agent 可按原 ID 续版，新稿使用明确的创建动作。

基线冲突先回读对应稿件的新版本和变更，再确认希望继续的修订。发布权取决于该稿件的发布身份，以 `canRevise` 为准。项目读取权限让接收者查看版本和回执。

## 提交与交付

- `design.json.project` 等于绑定的项目 ID。保留适用的固定框架和画面编号，包含 `design.json`、`思路.md` 与清单声明的单文件 HTML。标准新建由服务器分配 ID，清单和请求均省略稿件 ID。续版可沿用清单中的同稿 ID。
- 将源目录同步至获授权的项目 Git 分支，从完整提交导出 ZIP。ZIP 位于项目工作区且避开 `.cds` 和 `.git`，不超过 4 MiB。每次提交带 `zipPath`、`sourceCommit`、`sourcePath`、`requestId` 和相应意图字段。HTTP 使用同一项目的 `/design/packages`，内容为 ZIP，其余字段通过查询参数传递。
- 在 `note` 记录原版、改动画面、原因和待核验项。发布后按回执的 `designId` 与 `version` 回读，核对项目、源提交和归档摘要。响应不确定时以原 `requestId`、来源、意图和稿件内容重试。设计接入按 ZIP 内的文件内容识别重试。接收者从同一项目回读固定的新旧版，定位差异后复拍受影响画面。缺实拍仍标待核验。
