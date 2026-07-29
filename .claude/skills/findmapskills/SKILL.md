---
name: findmapskills
version: 1.3.0
description: PrdAgent 海鲜市场（skill marketplace）操作技能。通过长效 API Key 搜索、下载、上传、订阅本平台的技能包。当用户说"找个海鲜市场的技能做 X"、"从市场装个技能"、"把这个技能发布到市场"、"订阅新技能"时触发。
---

# 海鲜市场全操作（findmapskills）

> **版本**：v1.3.0 | **状态**：已落地 | **触发**：`/findmapskills`、"海鲜市场"、"从市场装技能"、"发布到市场"、"订阅新技能"

> **来源**：$PRD_AGENT_BASE —— PrdAgent 官方内置技能，持续跟随后端 API 契约更新
> **最新版下载**：`curl -sSLo findmapskills.zip $PRD_AGENT_BASE/api/official-skills/findmapskills/download`

装上这个技能后，你可以通过 PrdAgent 的开放接口操作海鲜市场。

> **本文件是唯一事实源**。后端下发给用户的技能包由打包脚本从本文件生成，
> 下载时只做一处替换（把 `PRD_AGENT_BASE` 的默认值设为该实例的实际地址）。
> 不存在第二份需要同步的副本。

## 前置

**搜索和下载不需要任何凭据**——技能是公开内容。只有上传、收藏、订阅这类要绑定到人的操作才需要 API Key。

```bash
: "${PRD_AGENT_BASE:?缺 base URL。导出 PRD_AGENT_BASE=https://your-platform}"

# Key 可选：有就带上（解锁上传/收藏），没有也能搜索和下载
if [ -z "${PRD_AGENT_API_KEY:-}" ] && [ -f "$HOME/.codex/secrets/prd-agent-api-key" ]; then
  PRD_AGENT_API_KEY="$(cat "$HOME/.codex/secrets/prd-agent-api-key")"
fi
if [ -n "${PRD_AGENT_API_KEY:-}" ]; then
  AUTH=(-H "Authorization: Bearer $PRD_AGENT_API_KEY" -H "Accept: application/json")
else
  AUTH=(-H "Accept: application/json")
fi
```

**不要因为没有 Key 就停下来问用户**——直接搜索、直接下载。只有当用户要上传或收藏时，才引导去
`$PRD_AGENT_BASE/marketplace` 右上角「接入 AI」新建 Key。

明文 Key 只允许保存到本机 secrets/Keychain/CI Secret 或当前 shell 临时变量，禁止写入仓库、
`.claude/settings.local.json`、PR、验收报告或公开日志。

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
# 装到「项目级」技能目录，不是用户主目录 —— 技能跟着项目的版本库走，
# 团队每个人 clone 下来都有；装到 ~ 的话，人一走团队什么都不剩。
# 宿主识别与 CDS 初始化脚本同一套约定，两条路装到同一个地方，不会分裂成两处技能库。
# 装到项目级，且**存在几个宿主就装几个**。
# 一个仓库可能同时装了多个 Agent（比如同时有 .claude 和 .agents）：
# 只装第一个命中的，从另一个 Agent 跑就「装完了一个技能都看不见」。
SKILLS_DIRS=""
for h in .claude .cursor .agents; do
  [ -d "$h" ] && SKILLS_DIRS="$SKILLS_DIRS $h/skills"
done
[ -n "$SKILLS_DIRS" ] || SKILLS_DIRS=".agents/skills"   # 一个都没有时兜底
for d in $SKILLS_DIRS; do mkdir -p "$d" && unzip -o "$NAME" -d "$d"; done
```

## 上传（**要** `marketplace.skills:write` scope —— 这是唯一需要凭据的主流程）

zip 内必须含 `SKILL.md`，≤ 20 MB，上传后默认公开。

```bash
curl -sS -X POST "$PRD_AGENT_BASE/api/open/marketplace/skills/upload" "${AUTH[@]}" \
  -F "file=@./my-skill.zip" \
  -F "title=我的新技能" \
  -F "description=30 字以内概述这个技能做什么" \
  -F 'tagsJson=["AI","效率"]'
```

**AI 上传时默认走幂等覆盖**：同一用户用同一 slug 反复上传 = 自动替换原条目，不要每次问用户"要不要覆盖"。slug 自动从 zip 内 `SKILL.md` 的 frontmatter `name:` 提取，所以 SKILL.md 写好 `name:` + `version:` 即可。

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

## 收藏（要 Key —— 收藏是绑定到人的操作）

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
3. **AI Agent 定期（每月）主动轮询** —— 用户说"帮我看看我装的海鲜市场技能还是不是最新的"时执行：

```bash
REMOTE_VERSION=$(curl -sSLo - "$PRD_AGENT_BASE/api/official-skills/findmapskills/download" \
  | unzip -p - findmapskills/SKILL.md | grep -oE '\*\*版本\*\*：[^（]+' | head -1)
echo "远端版本: $REMOTE_VERSION"
echo "本地版本: 1.3.0"
```

不一样就告诉用户：

> 你装的 findmapskills 版本是 **1.3.0**，平台上已经有更新。跑这条命令重装：
>
> ```bash
> # 这一段必须自带宿主识别：换个 shell 跑时 $SKILLS_DIRS 是空的，
> # for 循环会零次迭代然后正常退出——命令看着成功，技能一个没更新。
> SKILLS_DIRS=""
> for h in .claude .cursor .agents; do
>   [ -d "$h" ] && SKILLS_DIRS="$SKILLS_DIRS $h/skills"
> done
> [ -n "$SKILLS_DIRS" ] || SKILLS_DIRS=".agents/skills"
> curl -sSLo /tmp/findmapskills.zip "$PRD_AGENT_BASE/api/official-skills/findmapskills/download" \
>   && for d in $SKILLS_DIRS; do mkdir -p "$d" && unzip -o /tmp/findmapskills.zip -d "$d"; done
> ```

后端 `OfficialSkillTemplates.cs` 的 `FindMapSkillsVersion` 常量是本技能版本的权威源。
