# 设计闭环（`/cds 改 xx 模块的设计`）

用户只说一句话，例如「/cds 修复工程规划的看板，把逾期债务排到最前」。属于菜单「设计」。剩下的由本流程完成。

**交接只走 CDS**：需求、评论、实施反馈、验收结果都从 CDS 读，结果也写回 CDS，不让用户在设计对话和实现、测试对话之间转述。用户在对话里只做三件事：说要做什么，确认取舍，在 CDS 里定稿或签收。

## 一、找到稿件

1. 自检授权：`cdscli setup-check --host <CDS 地址> --project <项目 ID> --design-access publish`。缺少权限时按 [CDS 设计接入](design-intake.md) 发起申请，等系统所有者批准。不复制、不打印凭据。
2. 读接入清单：MCP `cds_design_read {view:"intake"}`，或 `cdscli design intake`。每份稿件有 `designKey`（`<模块>/<稿件>`）、最新版本、来源目录和能否续版。
3. 按用户说的模块匹配 `designKey` 或标题：
   - 匹配到一份：同稿续版，基于最新版本修改。
   - 匹配到多份：列出候选，问一次。
   - 没有匹配：新建稿件，`cdscli design scaffold --framework <框架编号> --dir design/<目录> --title "<标题>"`，`designKey` 用 `<模块>/<稿件>`。
4. 本地没有稿件目录时，从 CDS 下载最新版归档，解到 `design/<目录>`，再提交一次作为起点。

## 二、从 CDS 读上下文

动笔前读完下面几项，用户没说的不靠猜：

| 读什么 | 命令 | 用来做什么 |
| --- | --- | --- |
| 未关闭的评论 | `cdscli design comments <稿件编号> --open` | 本版要回应的意见，发布时用 `--resolves` 关闭 |
| 实施反馈 | MCP `cds_design_read {view:"feedback", id}` | 实现方提的复用、缺口、约束和验收问题 |
| 验收结果 | `cdscli design result <稿件编号>` | 哪些验收项没过、挡住了什么 |
| 实施基线和已实现版本 | MCP `cds_design_read {view:"design", id}` | 决定 `changes/` 要附完整源码差异的起点 |
| 交付资料 | MCP `cds_design_read {view:"delivery", id}` | 上一版的思路、交付说明和验收缺项 |

## 三、出稿

按 [出稿与发布前自查](design-intake.md#出稿与发布前自查) 修改原型、思路、交付说明和验收项，并按角色走查。设计内容、文案和取舍由智能体负责，其余交给程序。

## 四、发布（程序门禁）

```bash
node <技能根>/cds/scripts/design/release.mjs check --dir design/<目录> --full <实现所在版本>
```

1. 被驳回就按规则编号修改，再重跑，直到通过。不手改 `changes/`、`versions.json` 和 `交接清单.md`（按目标生成，给实现方的唯一一份清单）。
2. 提交稿件目录，然后用 `check` 打印的命令私有发布。续版带上 `--resolves "<评论编号>=如何处理"`。
3. 回读：`cdscli design list`，核对版本号、来源提交和文件摘要。
4. 登记：`release.mjs register --dir design/<目录> --commit <来源提交>`。首发后第一次登记带 `--design <稿件编号>`。
5. 回复实施反馈：MCP `cds_design_feedback {type:"feedback.reply", revision:<新版本>}`，正文指向 `交接清单.md`，请实现方按验收项编号逐条回复。实现方从 CDS 读到回复，不用用户转告。

## 五、告诉用户

最多五行：

- 稿件编号和新版本；
- 本版改了什么，写 2 到 3 条；
- 从实施基线到新版的净变化，引用 `changes/v<基线>-v<新版>/changes.md` 的计数；
- 门禁结果和自检结果；
- 需要人做的事，例如在 CDS 定稿、请评审人查看。

定稿和签收由获授权成员在 CDS 里操作，智能体不代办。
