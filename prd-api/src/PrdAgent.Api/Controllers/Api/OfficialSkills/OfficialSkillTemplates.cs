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
    public const string FindMapSkillsVersion = "1.0.0";

    /// <summary>
    /// 发版日期（ISO 8601）—— 用户判断"要不要重装"的关键信号。
    /// </summary>
    public const string FindMapSkillsReleaseDate = "2026-04-21";

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

```bash
curl -sS -X POST "$PRD_AGENT_BASE/api/open/marketplace/skills/upload" "${AUTH[@]}" \
  -F "file=@./my-skill.zip" \
  -F "title=我的新技能" \
  -F "description=30 字以内概述这个技能做什么" \
  -F "iconEmoji=🐟" \
  -F 'tagsJson=["AI","效率"]'
```

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
