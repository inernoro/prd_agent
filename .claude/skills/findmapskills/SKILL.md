---
name: findmapskills
description: Discovers and downloads skills from the PrdAgent 海鲜市场 (skill marketplace). Use when the user asks "有没有现成的技能能做 X", "找个本平台的技能", "从海鲜市场装个技能", "marketplace 有啥新技能" or similar requests for internal-platform skills. Complements `find-skills` (which searches the external skills.sh ecosystem) by searching the user's own PrdAgent skill marketplace over its Open API.
---

# findmapskills（海鲜市场技能发现）

This skill helps the user discover and install skills from **their PrdAgent 海鲜市场** (the internal skill marketplace), as opposed to the public `skills.sh` ecosystem that `find-skills` covers.

## When to Use This Skill

Trigger on intents like:

- "有没有现成的技能能做 X" / "find a marketplace skill for X"
- "我们平台海鲜市场里有啥技能"
- "装一个 海鲜市场 的技能" / "install a skill from the marketplace"
- "marketplace 有啥新技能" / "最新发布的技能"
- User references `/marketplace`, 海鲜市场, or the in-platform skill library
- User says "订阅技能更新" / "subscribe to new marketplace skills"

**Do not** use this skill for the public `skills.sh` ecosystem — that's what `find-skills` is for. The two are complementary.

## What is the 海鲜市场 Open API?

The PrdAgent admin ships a skill marketplace where users upload zip skill packages (with `SKILL.md` inside). A matching HTTP Open API lets external AI / agents browse, download, and upload skills over a long-lived API Key (`sk-ak-xxxx`).

Endpoints (all require `Authorization: Bearer $PRD_AGENT_API_KEY`):

| Method | Path | Scope | Purpose |
|---|---|---|---|
| `GET`  | `/api/open/marketplace/skills?keyword=&sort=hot|new&tag=&limit=` | `marketplace.skills:read`  | List public skills |
| `GET`  | `/api/open/marketplace/skills/{id}` | `marketplace.skills:read` | Get one skill |
| `GET`  | `/api/open/marketplace/skills/tags`  | `marketplace.skills:read` | List all tags (with counts) |
| `POST` | `/api/open/marketplace/skills/{id}/fork` | `marketplace.skills:read` | Download zip (counts +1, returns `downloadUrl` + `fileName`) |
| `POST` | `/api/open/marketplace/skills/upload` (multipart) | `marketplace.skills:write` | Upload new zip skill package |
| `POST` | `/api/open/marketplace/skills/{id}/favorite` | `marketplace.skills:read` | Favorite |
| `POST` | `/api/open/marketplace/skills/{id}/unfavorite` | `marketplace.skills:read` | Unfavorite |

**Response envelope**: all endpoints return `{ success: boolean, data: ..., error: { code, message } | null }`.

## Prerequisites

Before using this skill, the user must have:

1. **An API Key** — created via the Web UI button "接入 AI" on `/marketplace` (top-right). The plaintext key is shown **once** during creation.
2. **The key exposed as `PRD_AGENT_API_KEY`** in the current shell / process env.
3. **The platform's origin URL** (e.g. `https://prd-agent.example.com`). If unknown, ask the user or read from a project config.

If any of these are missing, tell the user what they need to do rather than guessing.

## Step 1: Verify the Environment

Before searching, run:

```bash
: "${PRD_AGENT_API_KEY:?set PRD_AGENT_API_KEY (see 海鲜市场 → 接入 AI)}"
: "${PRD_AGENT_BASE:=https://your-platform.example.com}"  # replace with the user's actual origin
echo "Using $PRD_AGENT_BASE with key prefix ${PRD_AGENT_API_KEY:0:12}..."
```

If `PRD_AGENT_API_KEY` is not set, stop and ask the user:

> 你还没设置 `PRD_AGENT_API_KEY`。请在 **海鲜市场 → 右上角"接入 AI"** 创建一个带
> `marketplace.skills:read` 权限的 Key，把明文 `export PRD_AGENT_API_KEY=sk-ak-xxxx` 之后我再继续。

## Step 2: Understand the User's Need

Identify:

1. **Domain / task**: e.g. "PR 审查", "水印配置", "视频脚本"
2. **Sort preference**: hot (popular) vs new (latest)
3. **Tag hints**: if the user mentioned specific tags

## Step 3: Search the Marketplace

Use `curl` to query — prefer keyword or tag search, with `sort=hot` for quality-biased results.

```bash
# Keyword search
curl -sS "$PRD_AGENT_BASE/api/open/marketplace/skills?keyword=PR%20%E5%AE%A1%E6%9F%A5&sort=hot&limit=20" \
  -H "Authorization: Bearer $PRD_AGENT_API_KEY" \
  -H "Accept: application/json" | jq '.data.items[] | {id, title, description, downloadCount, tags}'

# Tag search (run `/api/open/marketplace/skills/tags` first if unsure what tags exist)
curl -sS "$PRD_AGENT_BASE/api/open/marketplace/skills?tag=AI&sort=hot&limit=20" \
  -H "Authorization: Bearer $PRD_AGENT_API_KEY" | jq '.data.items[] | {id, title, downloadCount}'
```

## Step 4: Verify Quality Before Recommending

**Do not recommend a skill based solely on the first search hit.** Check:

1. **Download count** (`downloadCount`) — higher is more battle-tested
2. **Author** (`ownerUserName`) — if the user knows the author, that's a positive signal
3. **Description alignment** — does the 30-char summary actually match the user's intent?
4. **`hasSkillMd: true`** — skills missing a `SKILL.md` are lower quality

If the top result looks weak, widen the keyword or try a different tag.

## Step 5: Present Options to the User

Show 3-5 candidates as a list. Include:

- Title (emoji prefix if `iconEmoji` exists)
- 1-line description
- Download count + tags
- The fork command

Example rendering:

```
找到 3 个候选：

1. 🐟 PR 审查助手 — "扫描 PR diff，高亮风险与建议"
   120 次下载 · tags: PR, 代码审查, AI
   → curl -X POST "$PRD_AGENT_BASE/api/open/marketplace/skills/abc123/fork" ...

2. 🧪 测试用例生成器 — "从 SKILL.md 产出 xunit 测试"
   35 次下载 · tags: 测试, AI
   → ...
```

## Step 6: Fork (Download) the Selected Skill

On user confirmation, run fork and save the zip locally:

```bash
SKILL_ID="abc123"  # from step 5
RESP=$(curl -sS -X POST "$PRD_AGENT_BASE/api/open/marketplace/skills/$SKILL_ID/fork" \
  -H "Authorization: Bearer $PRD_AGENT_API_KEY" \
  -H "Content-Type: application/json" -d '{}')
URL=$(echo "$RESP"  | jq -r '.data.downloadUrl')
NAME=$(echo "$RESP" | jq -r '.data.fileName // "skill.zip"')
curl -sSL -o "$NAME" "$URL"
unzip -l "$NAME"  # 让用户看一下结构，确认是合法 SKILL 包
```

Then tell the user where the zip landed and suggest where to install it (e.g. `~/.claude/skills/<skill-name>/`).

## Step 7: Handle Expiry Gracefully

The API responds with these headers:

- `X-AgentApiKey-ExpiringSoon: true` / `X-AgentApiKey-DaysLeft: 29` — 30 天内过期，提醒用户在 UI 续期
- `X-AgentApiKey-Expiring: true` + `X-AgentApiKey-ExpiredAt: ...` — 已过期但在宽限期内，强烈建议续期
- HTTP `401 UNAUTHORIZED` with `Invalid, expired or revoked AgentApiKey` — key 已超过宽限期或被撤销

On `ExpiringSoon` / `Expiring` just surface a warning — the request still succeeded. On 401, tell the user exactly which Web UI button to click:

> 你的 API Key 过期了（超过 7 天宽限期）。请打开 **海鲜市场 → 接入 AI → 我的 Key**，点"续期一年"，
> 或者直接撤销重建一个新的。

## Subscribing to New Skills

There's no push-based subscription yet. For polling-based "subscribe to new skills":

```bash
# 把本地游标存在 ~/.prd-agent/last_marketplace_cursor
CURSOR=$(cat ~/.prd-agent/last_marketplace_cursor 2>/dev/null || echo "1970-01-01T00:00:00Z")
NEW_ITEMS=$(curl -sS "$PRD_AGENT_BASE/api/open/marketplace/skills?sort=new&limit=50" \
  -H "Authorization: Bearer $PRD_AGENT_API_KEY" \
  | jq --arg since "$CURSOR" '.data.items | map(select(.createdAt > $since))')
if [ "$(echo "$NEW_ITEMS" | jq 'length')" -gt 0 ]; then
  echo "有新技能："
  echo "$NEW_ITEMS" | jq '.[] | {title, description, createdAt}'
  echo "$NEW_ITEMS" | jq -r '.[0].createdAt' > ~/.prd-agent/last_marketplace_cursor
fi
```

Drop that into a cron / daily job if the user wants unattended subscriptions.

## Uploading Skills (requires `marketplace.skills:write`)

If the user wants to publish a skill they built:

```bash
curl -sS -X POST "$PRD_AGENT_BASE/api/open/marketplace/skills/upload" \
  -H "Authorization: Bearer $PRD_AGENT_API_KEY" \
  -F "file=@./my-skill.zip" \
  -F "title=我的新技能" \
  -F "description=30 字以内概述这个技能做什么" \
  -F "iconEmoji=🐟" \
  -F 'tagsJson=["AI","效率"]'
```

Before uploading, remind the user that:

- The zip must contain a `SKILL.md` at the top level (or in a single subdir)
- Max 20 MB
- Content becomes public by default — don't upload anything with secrets
- Their Key must have `marketplace.skills:write` scope (check on the "我的 Key" tab)

## Relationship to `find-skills`

- **`find-skills`** → searches the public `skills.sh` ecosystem (use for general, well-known skills)
- **`findmapskills`** → searches the user's own PrdAgent 海鲜市场 (use for team-internal / domain-specific skills)

When the user asks an open-ended "找个技能能做 X" question, consider running both in parallel and presenting combined results — public skills often have more installs, but marketplace skills are often more tailored to the team's workflow.
