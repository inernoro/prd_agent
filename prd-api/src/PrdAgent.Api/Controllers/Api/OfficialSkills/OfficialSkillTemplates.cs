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
    public const string AiDefectResolveVersion = "1.6.0";
    public const string AiDefectResolveReleaseDate = "2026-06-21";

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

`workflow/complete` 会同时写入缺陷结构化字段和更新中心关联用的 `defect_resolution_traces`。更新中心只读取 commit id 关联结果并展示，不负责人工关联缺陷。

真实闭环验收门禁：

1. `GET /agent/connector` 返回 200，证明 `domain + K` 可用。
2. `POST /agent/workflow/start-next` 返回 `runId` 和具体缺陷，且响应包含 `protocol.version == defect-agent-workflow.v1`。
3. `POST /agent/defects/{id}/comments` 返回 `messageId`，证明已评论开始分析和轻量判定。
4. 代码或技能实际产生 diff，并通过对应校验。
5. git commit 成功，取得完整 `commitSha`，并创建或更新 PR，取得 `pullRequestUrl`。
6. `POST /agent/workflow/complete` 返回成功，证明 PR、commit 已写回缺陷系统，且单缺陷已标记修复。
7. `workflow/complete` 返回下一次 `workflow/start-next` 入参，证明流程能继续下一条。
8. 阻塞或重量级缺陷必须调用 `POST /agent/workflow/block` 并写入失败原因。
9. 更新中心的 commit 记录 UI 必须出现可点击的“关联缺陷 N”或“我的缺陷 N”标志。点击后必须能看到缺陷编号、标题、PR、commit、发布状态、验收报告或知识库链接。提交者本人场景必须证明按钮显示“我的缺陷 N”或弹窗内出现“我提交的”。普通 changelog 文案行没有 commit id，不允许按日期批量贴缺陷标志。如果 commit 未正式发布，只能记录“需要真人审核发布”，不能冒充已发布。
10. 正式发布后才能跑 `create-visual-test-to-kb`，报告必须进入“缺陷修复验收报告”知识库。
11. 只有正式发布且验收通过后，才能调用 `validation-report` 通知提交人。

## 正式发布后的验收通知

1. `GET {domain}/api/defect-agent/agent/published-pending?limit=20` 拉取已正式发布但未通知提交人的修复记录。
2. 使用 `create-visual-test-to-kb` 跑正式环境验收，目标取 `item.acceptance.target`，正式地址取 `item.acceptance.previewUrl`。
3. 复制验收技能的 `acceptance.config.json` 到 `/tmp/defect-acceptance.config.json`，只在临时副本把 `report.storeName` 改为“缺陷修复验收报告”。
4. 归档必须走知识库传输共享协议：正文和截图 `assets[]` 一次性提交给知识库后端，由知识库决定正式图片域名和缓存刷新。禁止直接写 Mongo、禁止手动上传图片后拼 URL、禁止把 `data:image` 写进报告。
5. 视觉验收必须进入更新中心的 commit 记录列表，截取对应 commit 行上的“关联缺陷 N”或“我的缺陷 N”按钮；必须点击按钮并截取弹窗，证明缺陷编号、标题、发布状态、验收报告或知识库链接可见。普通 changelog 文案行不作为缺陷关联验收目标。
6. 归档后用 `verify-open.mjs` 打开报告地址，确认标题、正文和截图可见。
7. `POST {domain}/api/defect-agent/agent/resolution-traces/{traceId}/validation-report` 回写 `knowledgeBaseName`、`knowledgeBaseUrl`、报告地址、`verdict` 并通知提交人。`knowledgeBaseUrl` 必填；`fail` 结论会发送“需要继续改进”，不要提前发送“已修复”。如果正式验收报告证明用户描述不成立，`verdict` 使用 `invalid`，回复必须引用验收报告证明该结论。

## 轻量标准

- 预计改动不超过 200 行。
- 单个缺陷预计 10 分钟内能定位并完成主要修复。
- 根因清晰，行为可验证。
- 不涉及破坏性删除、数据库迁移、权限模型重写、跨服务协议改造。
- 能跑通本地测试、集成测试、CDS 预览或浏览器验收中的至少一条。

## 约束

- 有争议、破坏性、跨模块、接口签名或数据结构变更必须先请求人类确认。
- 一次只处理一个缺陷，提交并回写 commit 后再继续下一条。
- 不把密钥写入日志、提交、报告或评论。
- 评论和修复说明必须包含可验收步骤。
- 所有代码改动必须通过 PR 完成；只有 commit 没有 PR 不算闭环。
- 只 commit 不调用 `workflow/complete` 不算闭环完成；旧 `commit-info` 只用于兼容和排障。
- 正式发布前只在缺陷内更新进度，不给提交人发“已修复”通知。
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
    /// 每次修改 SKILL.md 内容时，同步撞版本号 + 更新 FindMapSkillsChangelog。
    /// 版本号会 embed 到 SKILL.md header 让 AI 和用户一眼看到"我装的是什么版本"。
    /// </summary>
    public const string FindMapSkillsVersion = "1.1.0";

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

    /// <summary>
    /// findmapskills SKILL.md：海鲜市场全操作手册。
    /// 占位符 <c>{{BASE_URL}}</c> 由运行时替换为请求来源的 origin，
    /// 这样 AI 拷贝即用，不需要再改硬编码 host。
    /// </summary>
    public const string FindMapSkillsSkillMd = """
---
name: findmapskills
description: PrdAgent 海鲜市场（skill marketplace）操作技能。通过长效 API Key 搜索、下载、上传、订阅本平台的技能包。当用户说"找个海鲜市场的技能做 X"、"从市场装个技能"、"把这个技能发布到市场"、"订阅新技能"时触发。
---

# findmapskills（海鲜市场全操作）

> **版本**：{{VERSION}}（{{RELEASE_DATE}}）
> **来源**：{{BASE_URL}} —— PrdAgent 官方内置技能，持续跟随后端 API 契约更新
> **最新版下载**：`curl -sSLo findmapskills.zip {{BASE_URL}}/api/official-skills/findmapskills/download`

装上这个技能后，你可以通过 PrdAgent 的开放接口操作海鲜市场。

## 前置

```bash
: "${PRD_AGENT_API_KEY:?缺 API Key。在 海鲜市场 → 右上角「接入 AI」新建。}"
: "${PRD_AGENT_BASE:={{BASE_URL}}}"
AUTH=(-H "Authorization: Bearer $PRD_AGENT_API_KEY" -H "Accept: application/json")
```

如果用户没设 `PRD_AGENT_API_KEY`，引导去 `{{BASE_URL}}/marketplace` 的「接入 AI」按钮新建。

## 搜索技能

```bash
# 关键字 + 热度
curl -sS "$PRD_AGENT_BASE/api/open/marketplace/skills?keyword=PR&sort=hot&limit=20" "${AUTH[@]}" \
  | jq '.data.items[] | {id,title,description,downloadCount,tags}'

# 列出所有 tag
curl -sS "$PRD_AGENT_BASE/api/open/marketplace/skills/tags" "${AUTH[@]}" | jq '.data.tags'

# 按 tag 过滤
curl -sS "$PRD_AGENT_BASE/api/open/marketplace/skills?tag=AI&sort=new&limit=20" "${AUTH[@]}"
```

## 下载（fork）

```bash
SKILL_ID="<从搜索结果拿到的 id>"
RESP=$(curl -sS -X POST "$PRD_AGENT_BASE/api/open/marketplace/skills/$SKILL_ID/fork" "${AUTH[@]}" \
  -H "Content-Type: application/json" -d '{}')
URL=$(echo "$RESP"  | jq -r '.data.downloadUrl')
NAME=$(echo "$RESP" | jq -r '.data.fileName // "skill.zip"')
curl -sSL -o "$NAME" "$URL"
unzip -o "$NAME" -d ~/.claude/skills/   # 安装到 Claude Code 技能目录
```

## 上传（要 `marketplace.skills:write` scope）

zip 内必须含 `SKILL.md`，≤ 20 MB，上传后默认公开。

**AI 上传时默认走幂等覆盖**：同一用户用同一 slug 反复上传 = 自动替换原条目，
不要每次问用户"要不要覆盖"。slug 自动从 zip 内 `SKILL.md` 的 frontmatter `name:` 提取，
所以 SKILL.md 写好 `name:` + `version:` 即可，AI 直接调用：

```bash
curl -sS -X POST "$PRD_AGENT_BASE/api/open/marketplace/skills/upload" "${AUTH[@]}" \
  -F "file=@./my-skill.zip" \
  -F "title=我的新技能" \
  -F "description=30 字以内概述这个技能做什么" \
  -F 'tagsJson=["AI","效率"]'
```

响应里关注两个字段：
- `replaced`: `true` = 覆盖了原条目；`false` = 新建
- `slug` / `version`: 实际入库的值（从 frontmatter 或参数推断）

如确实需要保留历史所有版本，加 `-F "replaceMode=always-new"`。
如要显式指定 slug/version，加 `-F "slug=my-cds"` `-F "version=1.2.0"`（优先级高于 frontmatter）。

### AI 上传决策树（无需向用户确认）

1. 判断 zip 内 `SKILL.md` 是否有 `name:` frontmatter → 有则 slug 已就位
2. 判断 frontmatter 是否有 `version:` → 有则版本已就位（手动 bump 一次）
3. 直接 POST，根据响应 `replaced` 报告"已覆盖 / 新发布"
4. 不要问"是否覆盖" / "用什么 slug" / "下一版本号是多少"，从 SKILL.md 推断即可

## 收藏

```bash
curl -sS -X POST "$PRD_AGENT_BASE/api/open/marketplace/skills/$SKILL_ID/favorite" "${AUTH[@]}" -d '{}'
curl -sS -X POST "$PRD_AGENT_BASE/api/open/marketplace/skills/$SKILL_ID/unfavorite" "${AUTH[@]}" -d '{}'
```

## 订阅新技能（轮询）

```bash
CURSOR=$(cat ~/.prd-agent/last_cursor 2>/dev/null || echo "1970-01-01T00:00:00Z")
curl -sS "$PRD_AGENT_BASE/api/open/marketplace/skills?sort=new&limit=50" "${AUTH[@]}" \
  | jq --arg since "$CURSOR" '.data.items | map(select(.createdAt > $since))'
```

把结果里最新一条 `createdAt` 写回 `~/.prd-agent/last_cursor` 即可。

## Key 过期处理

响应头会携带：
- `X-AgentApiKey-ExpiringSoon: true` + `X-AgentApiKey-DaysLeft: N` —— 30 天内过期
- `X-AgentApiKey-Expiring: true` —— 已过期但在 7 天宽限期内
- HTTP `401` —— 超过宽限期或被撤销

检测到前两种情况就提示用户：打开 `{{BASE_URL}}/marketplace` → 右上角「接入 AI」→ 我的 Key → 点「续期一年」。

## 响应契约

所有接口统一结构：`{ success: bool, data: {...}, error: { code, message } | null }`。
永远先判 `success`，不要看 HTTP 码。

## 如何更新此技能

这个技能包的内容随 PrdAgent 后端版本一起滚动更新。判断需不需要重装的 3 个信号：

1. **被调用接口返回 `UNKNOWN_FIELD` / 404** —— 后端已改契约，立即重装
2. **UI 海鲜市场卡片显示新的版本号**（在 `{{BASE_URL}}/marketplace` 搜 `findmapskills`，比较卡片上的版本号与本文件 header 的 `{{VERSION}}`）
3. **AI Agent 定期（每月）主动轮询** —— 用户说"帮我看看我装的海鲜市场技能还是不是最新的"时执行：

```bash
# 用 curl 下载最新版 SKILL.md 的前 2KB，抓 "版本：" 行比对
REMOTE_VERSION=$(curl -sSLo - "$PRD_AGENT_BASE/api/official-skills/findmapskills/download" \
  | unzip -p - findmapskills/SKILL.md | grep -oE '\*\*版本\*\*：[^（]+' | head -1)
echo "远端版本: $REMOTE_VERSION"
echo "本地版本: {{VERSION}}"
```

不一样就告诉用户：

> 你装的 findmapskills 版本是 **{{VERSION}}**（{{RELEASE_DATE}}），平台上已经有更新。跑这条命令重装：
>
> ```bash
> curl -sSLo /tmp/findmapskills.zip "$PRD_AGENT_BASE/api/official-skills/findmapskills/download" \
>   && unzip -o /tmp/findmapskills.zip -d ~/.claude/skills/
> ```

后端 `OfficialSkillTemplates.cs` 的 `FindMapSkillsVersion` 常量是本技能版本的权威源。
""";

    /// <summary>
    /// zip 里的 README.md，放在技能包根目录让用户解压后第一眼就能看到"我怎么用"。
    /// </summary>
    public const string FindMapSkillsReadme = """
# findmapskills 技能包

PrdAgent 海鲜市场的官方操作技能。装上之后 AI 就能帮你搜索 / 下载 / 上传 / 订阅市场里的技能。

**当前版本**：{{VERSION}}（{{RELEASE_DATE}}）
**最新版**：{{BASE_URL}}/api/official-skills/findmapskills/download

## 安装

### Claude Code

```bash
unzip findmapskills.zip -d ~/.claude/skills/
```

重启 Claude Code，说"找个海鲜市场里做 X 的技能"即可触发。

### Cursor / 其他 AI 工具

打开 SKILL.md 把里面的 curl 命令喂给 agent 即可。

## 环境变量

```bash
export PRD_AGENT_API_KEY="<在 {{BASE_URL}}/marketplace → 接入 AI 新建得到>"
export PRD_AGENT_BASE="{{BASE_URL}}"
```

## 文档

详见同目录 `SKILL.md`。
""";
}
