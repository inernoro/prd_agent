---
name: findmapskills
description: PrdAgent 海鲜市场（skill marketplace）操作技能。通过长效 API Key 搜索、下载、上传、订阅本平台的技能包。当用户说"找个海鲜市场的技能做 X"、"从市场装个技能"、"把这个技能发布到市场"、"订阅新技能"时触发。
---

# findmapskills（海鲜市场全操作）

> **版本**：1.0.0（2026-04-21）
> **来源**：PrdAgent 官方内置技能，持续跟随后端 API 契约更新
> **最新版下载**：`curl -sSLo findmapskills.zip $PRD_AGENT_BASE/api/official-skills/findmapskills/download`

装上这个技能后，你可以通过 PrdAgent 的开放接口操作海鲜市场。

> **注意**：此文件是**仓库内本地版**，供 Claude Code 直接识别。
> 真正对用户下发的技能包由后端动态生成，内容参见 `prd-api/src/PrdAgent.Api/Controllers/Api/OfficialSkills/OfficialSkillTemplates.cs` 中的 `FindMapSkillsSkillMd` 常量。
> 两份内容应保持一致 —— 下次修改时两边都要改。

## 前置

```bash
: "${PRD_AGENT_API_KEY:?缺 API Key。在 海鲜市场 → 右上角「接入 AI」新建。}"
: "${PRD_AGENT_BASE:?缺 base URL。导出 PRD_AGENT_BASE=https://your-platform}"
AUTH=(-H "Authorization: Bearer $PRD_AGENT_API_KEY" -H "Accept: application/json")
```

如果用户没设 `PRD_AGENT_API_KEY`，引导去 `$PRD_AGENT_BASE/marketplace` 的「接入 AI」按钮新建。

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

检测到前两种情况就提示用户：打开 `$PRD_AGENT_BASE/marketplace` → 右上角「接入 AI」→ 我的 Key → 点「续期一年」。

## 响应契约

所有接口统一结构：`{ success: bool, data: {...}, error: { code, message } | null }`。
永远先判 `success`，不要看 HTTP 码。

## 如何更新此技能

这个技能包的内容随 PrdAgent 后端版本一起滚动更新。判断需不需要重装的 3 个信号：

1. **被调用接口返回 `UNKNOWN_FIELD` / 404** —— 后端已改契约，立即重装
2. **UI 海鲜市场卡片显示新的版本号**（在 `$PRD_AGENT_BASE/marketplace` 搜 `findmapskills`，比较卡片上的版本号与本文件 header 的版本）
3. **AI Agent 定期（每月）主动轮询**

```bash
REMOTE_VERSION=$(curl -sSLo - "$PRD_AGENT_BASE/api/official-skills/findmapskills/download" \
  | unzip -p - findmapskills/SKILL.md | grep -oE '\*\*版本\*\*：[^（]+' | head -1)
echo "远端版本: $REMOTE_VERSION"
echo "本地版本: 1.0.0"
```

不一样就告诉用户：

> 你装的 findmapskills 版本是 **1.0.0**（2026-04-21），平台上已经有更新。跑这条命令重装：
>
> ```bash
> curl -sSLo /tmp/findmapskills.zip "$PRD_AGENT_BASE/api/official-skills/findmapskills/download" \
>   && unzip -o /tmp/findmapskills.zip -d ~/.claude/skills/
> ```

后端 `OfficialSkillTemplates.cs` 的 `FindMapSkillsVersion` 常量是本技能版本的权威源。
