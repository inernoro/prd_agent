# 测试闭环（`/cds 领一个验收任务`）

用户只说一句话，例如「/cds 领一个验收任务」或「/cds 跑工程规划稿件的验收」。属于菜单「验收中心」。剩下的由本流程完成。

**交接只走 CDS**：要测什么、按哪一版测、结果和证据都放在 CDS。设计方和实现方从 CDS 读结果，不靠用户在对话之间转述。

## 一、看有什么要测

CDS 上有两类测试，先都列出来，再按用户的话选：

| 类型 | 列表 | 测什么 |
| --- | --- | --- |
| 结构化验收任务 | `cdscli acceptance tasks --project <项目 ID>` | 清单里的用例，例如正式环境巡检、回归 |
| 设计稿验收 | `cdscli design list`，加上 MCP `cds_design_read {view:"delivery", id}` | 已定稿版本的验收项，逐画面逐主题核对 |

- 用户点名了任务、稿件或模块：直接选中。
- 没点名：列出待领取的任务和有缺项的稿件，每行写编号、标题、待测数量，然后问一次。

## 二、领取

- 结构化任务：`cdscli acceptance claim <任务编号> --agent <智能体名称>`。执行期间定时 `acceptance heartbeat <任务编号>`；中途放弃就 `acceptance release <任务编号>`，交还给别人。领取票据不打印。
- 设计稿验收：只测实施基线那一版。`cdscli design accept <稿件编号> --pr <PR 编号> --commit <完整提交>` 创建验收运行，同时自动采集截图。只建运行、证据由人补时加 `--start-only`。

## 三、执行

- 页面和功能验收走 `create-visual-test-to-kb`：模拟用户操作的浏览器取证，覆盖明暗两种主题，并按报告结构生成报告。真实预览地址用 `cdscli preview-url` 查询，不手拼地址。
- 测量项按验收项里写的「检查：」或 `probe` 去测，只记实测值，不估。
- 前置条件不满足时（预览没部署、提交对不上、缺权限），这一项记为未执行，写明补跑入口，不记成通过。

## 四、写回 CDS

| 类型 | 写回 |
| --- | --- |
| 结构化任务 | 每个用例：`acceptance result <任务编号> --case <用例编号> --file <结果.json>`；全部写完后 `acceptance complete <任务编号>`，再 `acceptance archive-report <任务编号>` |
| 设计稿验收 | 补证据：`design record <稿件编号> --run <运行编号> --file <证据> --commit <完整提交>`；读结果：`design result <稿件编号>` |
| 发现的问题 | 设计问题写成实施反馈：MCP `cds_design_feedback {type:"feedback.create", category:"acceptance", screenId, evidence}`。设计方改稿时会读到。代码缺陷交给对应的修复流程 |

结果文件里不放凭据、真实账号或个人数据。

## 五、告诉用户

最多五行：

- 测的是哪个任务或稿件，按哪一版、哪个提交测的；
- 通过、失败、未执行各多少；
- 失败的前三项，以及它们挡住了什么；
- CDS 上的报告或运行链接；
- 需要人做的事，例如在 CDS 签收。

签收由获授权成员在 CDS 里操作，智能体不代办。
