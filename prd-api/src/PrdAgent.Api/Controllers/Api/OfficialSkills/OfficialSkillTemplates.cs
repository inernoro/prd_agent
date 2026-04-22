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
""";

    /// <summary>
    /// zip 里的 README.md，放在技能包根目录让用户解压后第一眼就能看到"我怎么用"。
    /// </summary>
    public const string FindMapSkillsReadme = """
# findmapskills 技能包

PrdAgent 海鲜市场的官方操作技能。装上之后 AI 就能帮你搜索 / 下载 / 上传 / 订阅市场里的技能。

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
