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
    public const string MarketplaceOpenApiSkillKey = "marketplace-openapi";

    /// <summary>
    /// "海鲜市场开放接口"技能的 SKILL.md 文本。
    /// 占位符 <c>{{BASE_URL}}</c> 由运行时替换为请求来源的 origin，
    /// 这样 AI 拷贝即用，不需要再改硬编码 host。
    /// </summary>
    public const string MarketplaceOpenApiSkillMd = """
---
name: marketplace-openapi
description: PrdAgent 海鲜市场开放接口官方技能。让 Claude / Cursor / 任意 AI Agent 通过 Bearer API Key 授权式浏览、下载、上传本平台海鲜市场的技能包。用户询问"怎么用本平台的技能"、"从海鲜市场装一个技能"、"找个平台市场里的技能"时触发。
---

# 海鲜市场开放接口（Marketplace Open API）

This is the official client skill for the PrdAgent 海鲜市场 (skill marketplace). Once installed, the user can say things like "找个海鲜市场里做 PR 审查的技能" / "把这个技能包发布到市场" and you will handle the rest by calling the platform Open API.

## 前置条件（Prerequisites）

Before using this skill, the user must have:

1. **An API Key** — created via the Web UI button "接入 AI" on `/marketplace` (top-right).
   The plaintext key is shown **once** during creation.
2. **The key exposed as `PRD_AGENT_API_KEY`** in the current shell / process env.
3. **Platform base URL** — this skill was generated for `{{BASE_URL}}`.
   If the user access the API from a different origin, set `PRD_AGENT_BASE` to override.

If any missing, tell the user:

> 你还没设置 `PRD_AGENT_API_KEY`。请在 **海鲜市场 → 右上角"接入 AI"** 创建一个带
> `marketplace.skills:read` 权限的 Key，复制明文后执行 `export PRD_AGENT_API_KEY=sk-ak-xxxx`，之后我再继续。

## 环境变量模板

让用户在 shell / CI 里设置：

```bash
export PRD_AGENT_API_KEY="sk-ak-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export PRD_AGENT_BASE="{{BASE_URL}}"   # 可选，默认就是这个值
```

## 核心能力（What This Skill Provides）

### 1. 搜索技能（Search skills）

```bash
: "${PRD_AGENT_API_KEY:?}"
: "${PRD_AGENT_BASE:={{BASE_URL}}}"

# 按关键字 + 热度排序
curl -sS "$PRD_AGENT_BASE/api/open/marketplace/skills?keyword=PR&sort=hot&limit=20" \
  -H "Authorization: Bearer $PRD_AGENT_API_KEY" | jq '.data.items[] | {id,title,description,downloadCount,tags}'

# 按 tag 搜
curl -sS "$PRD_AGENT_BASE/api/open/marketplace/skills/tags" \
  -H "Authorization: Bearer $PRD_AGENT_API_KEY" | jq '.data.tags'
```

### 2. 下载技能 zip（Fork a skill）

```bash
SKILL_ID="abc123"
RESP=$(curl -sS -X POST "$PRD_AGENT_BASE/api/open/marketplace/skills/$SKILL_ID/fork" \
  -H "Authorization: Bearer $PRD_AGENT_API_KEY" -H "Content-Type: application/json" -d '{}')
URL=$(echo "$RESP"  | jq -r '.data.downloadUrl')
NAME=$(echo "$RESP" | jq -r '.data.fileName // "skill.zip"')
curl -sSL -o "$NAME" "$URL"
unzip -l "$NAME"
```

安装到 Claude Code：`unzip` 后把解压目录放到 `~/.claude/skills/<skill-name>/`。

### 3. 上传技能（Upload a skill，需 `marketplace.skills:write` scope）

```bash
curl -sS -X POST "$PRD_AGENT_BASE/api/open/marketplace/skills/upload" \
  -H "Authorization: Bearer $PRD_AGENT_API_KEY" \
  -F "file=@./my-skill.zip" \
  -F "title=我的新技能" \
  -F "description=30 字以内概述这个技能做什么" \
  -F "iconEmoji=🐟" \
  -F 'tagsJson=["AI","效率"]'
```

上传前提醒用户：zip 必须含 `SKILL.md`、≤ 20 MB、上传后默认公开。

### 4. 收藏 / 取消收藏

```bash
curl -sS -X POST "$PRD_AGENT_BASE/api/open/marketplace/skills/$SKILL_ID/favorite" \
  -H "Authorization: Bearer $PRD_AGENT_API_KEY" -d '{}'

curl -sS -X POST "$PRD_AGENT_BASE/api/open/marketplace/skills/$SKILL_ID/unfavorite" \
  -H "Authorization: Bearer $PRD_AGENT_API_KEY" -d '{}'
```

### 5. 轮询订阅新技能

```bash
CURSOR=$(cat ~/.prd-agent/last_marketplace_cursor 2>/dev/null || echo "1970-01-01T00:00:00Z")
curl -sS "$PRD_AGENT_BASE/api/open/marketplace/skills?sort=new&limit=50" \
  -H "Authorization: Bearer $PRD_AGENT_API_KEY" \
  | jq --arg since "$CURSOR" '.data.items | map(select(.createdAt > $since))'
```

## 处理 Key 过期（Don't let the user get 403'd）

API 会返回以下响应头：

- `X-AgentApiKey-ExpiringSoon: true` + `X-AgentApiKey-DaysLeft: N` —— 30 天内过期，提示续期
- `X-AgentApiKey-Expiring: true` —— 已过期但在 7 天宽限期内，请求仍成功
- HTTP `401` + `Invalid, expired or revoked AgentApiKey` —— 超过宽限期或已撤销

在前两种情况下，向用户显式提示：

> 你的 API Key 将在 N 天后过期。请打开 **海鲜市场 → 接入 AI → 我的 Key**，点"续期一年"按钮即可延长 365 天。

## 响应契约（Response Envelope）

所有接口返回统一格式：

```json
{
  "success": true,
  "data": { /* ... */ },
  "error": null
}
```

失败时：

```json
{
  "success": false,
  "data": null,
  "error": { "code": "PERMISSION_DENIED", "message": "此接口要求 scope: marketplace.skills:write" }
}
```

永远先判 `success`，不要看 HTTP 码（契约下 401/403 也可能有 body）。

## 与 find-skills 的关系

- `find-skills` → 搜 `skills.sh` 公共生态
- `marketplace-openapi`（本技能）→ 搜用户自己的 PrdAgent 海鲜市场

用户问"找个技能" 且意图不明确时，两个都调用，合并展示。
""";

    /// <summary>
    /// zip 里的 README.md，放在技能包根目录让用户解压后第一眼就能看到"我怎么用"。
    /// </summary>
    public const string MarketplaceOpenApiReadme = """
# marketplace-openapi 技能包

PrdAgent 海鲜市场开放接口的官方客户端技能。

## 快速安装

### Claude Code

```bash
unzip marketplace-openapi.zip -d ~/.claude/skills/
```

重启 Claude Code，说"找个海鲜市场里做 X 的技能" 就会自动触发。

### Cursor / 其他 AI 工具

打开 SKILL.md 阅读调用方式，把对应 curl/TS/Python 代码写进你的 agent 配置即可。

## 环境变量

```bash
export PRD_AGENT_API_KEY="sk-ak-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export PRD_AGENT_BASE="{{BASE_URL}}"
```

API Key 从 **{{BASE_URL}}/marketplace → 右上角「接入 AI」→ 新建 Key** 获取，
明文只显示一次，妥善保存。

## 文档

完整调用方法见同目录下 `SKILL.md`。
""";
}
