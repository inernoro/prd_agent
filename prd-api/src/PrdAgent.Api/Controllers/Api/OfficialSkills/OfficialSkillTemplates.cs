namespace PrdAgent.Api.Controllers.Api.OfficialSkills;

/// <summary>
/// 平台官方技能包的 SKILL.md + README 内嵌模板。
///
/// 为什么不从磁盘读？
/// - 容器 WORKDIR 下没有 .claude/skills 目录（build artifact 不含 repo 元数据）
/// - 这是平台对外承诺的官方接入技能，必须跟 API 版本强绑定 —— 用代码嵌入的方式保证版本一致
///
/// 扩展位：往下再加新技能时，在 OfficialSkillCatalog 里登记一条即可。
/// </summary>
public static class OfficialSkillTemplates
{
    public const string AiDefectResolveKey = "ai-defect-resolve";
    public const string AiDefectResolveVersion = "1.9.1";
    public const string AiDefectResolveReleaseDate = "2026-07-17";

    public const string AiDefectResolveSkillMd = """
---
name: ai-defect-resolve
description: AI 辅助缺陷修复技能。用于缺陷自动化日常任务：通过 MAP/PrdAgent domain 和长期 AgentApiKey 使用缺陷工作流协议领取单个缺陷，完成轻量修复、提交 commit、回写提交信息，并兼容缺陷分享 agentLaunch。
---

# AI 辅助缺陷修复

> 版本：{{VERSION}}（{{RELEASE_DATE}}）
> 来源：{{BASE_URL}} 官方下载兜底包。
> 项目内置优先：如果当前仓库存在 `.claude/skills/ai-defect-resolve/SKILL.md` 或同等项目内置技能，必须使用项目内置版本；不得用托管/市场/官方下载版本覆盖项目内置技能。

本技能的主目标是自动化闭环，不是让人在更新中心手动关联缺陷。

## 主输入

日常任务优先使用缺陷页面“缺陷自动化”按钮复制出的 `domain + K`：

- `domain`：MAP/PrdAgent 域名。
- `K`：长期 AgentApiKey，推荐名称为“缺陷处理 Agent 授权”。
- `scope`：K 必须包含 `defect-agent:use`。

日常执行缺少 domain 或 K 时停止，不要猜测环境变量、历史密钥或默认主站。

首次 setup 推荐在缺陷页面点击“缺陷自动化”按钮，再点击“生成并复制每日任务配置”。这会生成名为“缺陷处理 Agent 授权”的长期 K，并把每日计划内容复制到剪贴板。

接口 setup 可以只提供 domain，但必须由登录用户发起：

```http
POST {domain}/api/defect-agent/agent/authorization/ensure
Content-Type: application/json

{
  "forceNew": false
}
```

已有可用 Key 时复用并返回元信息；没有时新建永不过期 K 并仅本次返回明文 `apiKey`。后端不保存明文 K，日常任务必须保存这次返回的 K。明文丢失时，重新点击按钮生成新 K。

兼容输入：

- 如果用户提供 `agentLaunch` 且 `scope.type == daily-next`，按其中的 `domain/auth/scope.nextUrl` 执行。
- 如果只有 `scope.shareUrl`，仍可按分享端点处理，但不要把分享链接当成日常任务主路径。

## 自动化流程

每一轮只处理一个缺陷：

1. `GET {domain}/api/defect-agent/agent/connector` 确认连接器协议和长期授权。响应会返回连接器类型、当前 K 元信息、授权创建建议和自动化端点清单。
2. `POST {domain}/api/defect-agent/agent/workflow/start-next` 创建或复用运行记录，并领取下一条缺陷。响应必须包含 `protocol.version == defect-agent-workflow.v1`。
3. `POST {domain}/api/defect-agent/agent/defects/{defectId}/comments` 评论修复计划，body 带 `runId`。
4. 按轻量标准判断能否自动修复；重量级问题调用 `POST /api/defect-agent/agent/workflow/block` 写失败原因并默认停止。
5. 轻量修复后执行代码校验并提交中文 commit。
6. `POST {domain}/api/defect-agent/agent/workflow/complete` 一次性回写 `commitSha`、分支、预览和验收报告地址，写入 `defect_resolution_traces`，并标记缺陷已修复。
7. `workflow/complete` 返回下一次 `workflow/start-next` 入参；再拉下一条，重复以上步骤。

旧端点 `runs`、`next`、`comments`、`commit-info`、`fix-status` 只用于兼容和排障；日常自动化优先使用 `defect-agent-workflow.v1`。

如果仓库存在 `scripts/defect-automation-probe.mjs`，日常任务启动前必须先运行安全自检：

```bash
DEFECT_AGENT_DOMAIN="{domain}" DEFECT_AGENT_KEY="{K}" node scripts/defect-automation-probe.mjs --safe
```

安全自检只调用 `connector` 和 `published-pending`，不会领取缺陷。它必须证明 `auth.requiredScope == defect-agent:use` 且 `workflow.version == defect-agent-workflow.v1`。自检失败时停止本轮，不要调用 `start-next`。

`workflow/complete` 会同时写入缺陷结构化字段和更新中心关联用的 `defect_resolution_traces`。更新中心只读取 commit id 关联结果并展示，不负责人工关联缺陷。

闭环验收不能只看接口：更新中心的 commit 记录 UI 应出现可点击的“关联缺陷 N”或“我的缺陷 N”标志。点击后应能看到缺陷编号、标题、发布状态、验收报告或知识库链接。提交者本人场景应证明按钮显示“我的缺陷 N”或弹窗内出现“我提交的”。普通 changelog 文案行没有 commit id，不允许按日期批量贴缺陷标志。目标 commit 越出最近一周列表、预览分支下线或弹窗截图失败时，应将闭环证据标为不完整并用完整历史、PR、commit 或 API trace 兜底，不得把已经通过的功能验收降为失败。

发布后验收必须做双轴判定：`functionalVerdict` 只根据用户可见行为、自测和回归风险取 `pass`、`conditional`、`fail` 或 `invalid`；`evidenceStatus` 只描述更新中心 commit 行、关联弹窗、报告可访问性和截图是否 `complete`、`partial` 或 `blocked`。报告与缺陷评论必须分别写明两轴结论。

`validation-report.verdict` 映射：功能通过且证据完整用 `pass`；功能通过但证据不完整用 `conditional`，消息以“功能验收通过；闭环证据不完整”开头；功能本身有已确认限制也用 `conditional` 并单独说明；只有用户可见功能仍失败、出现回归，或缺少关键功能验证而无法确认修复时才用 `fail` 和“需要继续改进”；正式证据证明缺陷陈述不成立用 `invalid`。自动化取证能力不足不得描述成代码仍未修复。

知识库归档的 `reportVerdict` 只能取 `pass`、`conditional` 或 `fail`。当功能核验结论为 `invalid` 时，使用 `reportVerdict=conditional` 归档，正文明确写“缺陷陈述不成立”并引用证据；归档成功后，正式系统 `validation-report.verdict` 再使用 `invalid`。不得把 `invalid` 传给 `create-visual-test-to-kb` 或 `archive_report.py`。

## 正式发布后的验收通知

1. `GET {domain}/api/defect-agent/agent/published-pending?limit=20` 拉取已正式发布但未通知提交人的修复记录。
2. 正式缺陷系统只负责读取待验收 trace 和回写通知；使用 `create-visual-test-to-kb` 在测试或预览环境跑视觉验收，目标取 `item.acceptance.target`，验收地址取 `item.acceptance.previewUrl`。
3. 复制验收技能的 `acceptance.config.json` 到 `/tmp/defect-acceptance.config.json`，只在临时副本把 `report.storeName` 改为“缺陷修复验收报告”。
4. 视觉验收应进入更新中心的 commit 记录列表，截取对应 commit 行上的“关联缺陷 N”或“我的缺陷 N”按钮，并点击按钮截取弹窗，证明缺陷编号、标题、发布状态、验收报告或知识库链接可见。若 UI 因时间窗口或环境状态无法展示目标 commit，按双轴规则标记证据缺口并记录兜底证据，不得直接判功能失败。普通 changelog 文案行不作为缺陷关联验收目标。
5. 归档后用 `verify-open.mjs` 打开报告地址，确认标题、正文和截图可见。
6. `POST {domain}/api/defect-agent/agent/resolution-traces/{traceId}/validation-report` 回写 `knowledgeBaseName`、`knowledgeBaseUrl`、报告地址、`verdict` 并通知提交人。`knowledgeBaseUrl` 必填；只有功能验收为 `fail` 才发送“需要继续改进”。`conditional` 必须提供 `message`，分别说明功能结论、闭环证据状态以及限制或缺口，缺少时后端返回 400。

## 轻量标准

- 预计改动不超过 200 行。
- 单个缺陷预计 10 分钟内能定位并完成主要修复。
- 根因清晰，行为可验证。
- 不涉及破坏性删除、数据库迁移、权限模型重写、跨服务协议改造。
- 能跑通本地测试、集成测试、CDS 预览或浏览器验收中的至少一条。

## 自治纪律（自主边界 + 五层自治回路）

本技能不是线性脚本，是有边界、能担责的自治体系。动手前先定档，再按五层自检。判定口诀：动手前先问“这条该不该我全权改，还是该停下问人”。

### 自主三档边界（动手前先定档）

- 全权自主：轻量（≤200 行 / ≤10 分钟 / 根因清晰 / 可自测）→ 直接修 → `workflow/complete`。
- 请示后做：超阈值 / 根因不清 / 影响面大 → 评论说明 → `workflow/block`（`stopRun=true`）。
- 禁止自动做：破坏性删除 / DB 迁移 / 权限模型重写 / 跨服务协议改造 / 无法自测的关键路径 → 一律 `block` 升级，绝不自动执行。

### 五层自治回路（每条缺陷按序自检）

1. 认知：领单后还原“这条缺陷要解决的真实问题”，并实际复现/定位，确认描述仍成立；与现状不符 → `block`（`failurePhase=analysis`），不照过时描述改。
2. 规划：即使行数小，也心算成功率 / 影响面 / 回滚代价；高风险或没把握主动降档“请示后做”。
3. 执行：实况与预判严重不符就停下重规划或 `block`（`failurePhase=fix`）；推送前跑通至少一条真实自测。
4. 记忆：动手前查同模块 / 同症状历史处置（`git log`、已有修复 commit、相似缺陷评论），复用经验与踩过的坑。
5. 监督：三道事前阀——合规红线（禁止项 / 跨环境）拒绝；不确定就 `block` 升级而非硬猜；同一缺陷反复 fix-break-fix 或长任务兜圈 → 停 + 在 `failureReason` 标 `loopGuard`。

complete / block 前自查：定了档且确属“全权自主”才 `complete`；认知 / 规划 / 执行 / 记忆 / 监督五条都过。任一为否，转 `block` 或降档，不许 `complete`。

## 约束

- 有争议、破坏性、跨模块、接口签名或数据结构变更必须先请求人类确认。
- 一次只处理一个缺陷，提交并回写 commit 后再继续下一条。
- 不把密钥写入日志、提交、报告或评论。
- 评论和修复说明必须包含可验收步骤。
- 只 commit 不调用 `workflow/complete` 不算闭环完成；旧 `commit-info` 只用于兼容和排障。
- 正式发布前只在缺陷内更新进度，不给提交人发“已修复”通知。
- `start-next` 返回 `hasNext=false` 时正常结束，不创建 PR，不制造测试缺陷。
""";

    public const string AiDefectResolveReadme = """
# ai-defect-resolve

PrdAgent 缺陷修复官方兜底技能包。

安装后优先用缺陷系统 domain 和长期 AgentApiKey 运行日常自动修复。若项目仓库已内置同名技能，请使用项目内置版本。

最新版下载：

```bash
curl -sSLo ai-defect-resolve.zip {{BASE_URL}}/api/official-skills/ai-defect-resolve/download
```
""";

    /// <summary>
    /// 海鲜市场操作技能 —— 唯一官方下载包。
    /// AI 装上这一个技能就可以搜索 / 下载 / 上传 / 订阅海鲜市场。
    /// 命名与 `.claude/skills/findmapskills/` 对齐。
    /// </summary>
    public const string FindMapSkillsKey = "findmapskills";

    /// <summary>
    /// 当前技能包版本号。
    ///
    /// 更新策略（SemVer）：
    /// - PATCH (1.0.0 → 1.0.1)：修 typo、优化文档措辞、不影响调用方
    /// - MINOR (1.0.1 → 1.1.0)：新增可选功能；老调用方无感知
    /// - MAJOR (1.1.0 → 2.0.0)：API 契约变更（请求/响应字段改名、删除）；老调用方必须升级
    ///
    /// 值取自 `.claude/skills/findmapskills/SKILL.md` 的 frontmatter `version:`，
    /// 经打包脚本进入 catalog —— 改版本只改技能文件那一处，这里不再单独维护。
    /// </summary>
    public static string FindMapSkillsVersion =>
        OfficialSkillCatalog.Find(FindMapSkillsKey)?.Version ?? "1.2.0";

    /// <summary>
    /// 发版日期（ISO 8601 字符串）—— 用户判断"要不要重装"的关键信号。
    /// </summary>
    public const string FindMapSkillsReleaseDate = "2026-05-01";

    /// <summary>
    /// 发版日期（强类型 UTC）—— 给 createdAt/updatedAt 等需要 DateTime 字段的地方用，
    /// 避免在请求路径上反复 DateTime.Parse 引入文化敏感性 + 性能损耗。
    /// 改版本时连同 FindMapSkillsReleaseDate 一起改。
    /// </summary>
    public static readonly DateTime FindMapSkillsReleaseDateUtc =
        new(2026, 5, 1, 0, 0, 0, DateTimeKind.Utc);

    // findmapskills 的 SKILL.md 与 README 已迁出本文件。
    // 唯一事实源 = `.claude/skills/findmapskills/`，由 scripts/bundle-official-skills.mjs
    // 打进 official-skills.generated.json，下载时走 OfficialSkillCatalog 通道。
    // 原先这里内嵌第二份、需要人工同步，实测已经开始漂移（2026-07-28 合并为一份）。


    // findmapskills 的 README.md 同样迁到 `.claude/skills/findmapskills/README.md`，
    // 随 catalog 一起打包下发。ai-defect-resolve 仍走本文件的内嵌模板。

}
