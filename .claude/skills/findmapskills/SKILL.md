---
name: findmapskills
metadata:
  version: "1.4.0"
description: 搜索、下载、上传和订阅 MAP 海鲜市场技能；区分用户上传与仓库官方目录同步，核验发布后的版本和下载内容。用于找市场技能、安装技能、发布技能、官方上架、同步官方技能或检查更新。
---

# 海鲜市场全操作（findmapskills）

> **版本**：v1.4.0 | **状态**：已落地 | **触发**：`/findmapskills`、"海鲜市场"、"从市场装技能"、"官方技能同步"、"发布到市场"、"订阅新技能"

> **来源**：$PRD_AGENT_BASE —— PrdAgent 官方内置技能，持续跟随后端 API 契约更新
> **最新版下载**：`curl -sSLo findmapskills.zip $PRD_AGENT_BASE/api/official-skills/findmapskills/download`

装上这个技能后，你可以通过 PrdAgent 的开放接口操作海鲜市场。

> **本文件是唯一事实源**。后端下发给用户的技能包由打包脚本从本文件生成，
> 下载时只做一处替换（把 `PRD_AGENT_BASE` 的默认值设为该实例的实际地址）。
> 不存在第二份需要同步的副本。

## 操作分流

| 用户目标 | 路径 | 完成依据 |
|---|---|---|
| 找技能、下载、检查更新 | 已连接 MAP MCP 优先；公开搜索、详情与 ZIP 下载也可直接调用 | 实际取到包并检查版本、文件内容 |
| 以自己的身份上传技能 | 本文用户上传流程，同一 owner + slug 幂等覆盖 | 上传响应的 replaced、slug、version，再搜索和下载复核 |
| 作为平台官方同步、上架或更新技能 | 读取 [官方同步与发布](references/official-publishing.md)；维护仓库目录，随 API 发布生效 | 正式实例能搜到官方版本，下载包与发布提交一致 |

“作为官方”不等于用个人 Key 上传，也不需要手工插入市场数据库。普通使用者没有平台仓库时，只消费官方包，不在自己的项目里仿造平台目录。

本技能的操作说明不新增合并或生产发布权限；沿用本次任务已有授权，按仓库约定执行。下列分节按需阅读：

- [搜索技能](#搜索技能)、[下载与安装](#下载与安装)、[用户上传](#用户上传)
- [订阅新技能](#订阅新技能轮询)、[如何更新此技能](#如何更新此技能)
- 官方维护读 [同步、集成、发布和验证](references/official-publishing.md)
- 工具不匹配、误判更新或取证失败读 [实战坑与处理](references/field-notes.md)

## 前置

**公开搜索、下载和轮询不需要凭据**。上传、收藏等绑定到人的操作才需要 API Key。

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

使用 MCP 前先读实时 schema；工具支持 `clientRequestId` 时，同一次有副作用的操作及其重试保持标识和原始参数一致。遇到 `TASK_INTENT_REQUIRED`，按[实战排错](references/field-notes.md)处理，不把它解释为技能不存在或需要重新上传。

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

## 下载与安装

只取公开包时，直接使用搜索或详情响应的 `zipUrl`，不必先做 POST fork，也不必附带 Key。MCP 的搜索、详情或取包工具可用时优先复用；取包工具的 schema 不满足服务端操作标识要求时，公开 GET 下载链路仍可使用。

```bash
set -e
SKILL_ID="<从搜索结果拿到的 id>"
RESP=$(curl -fsS "$PRD_AGENT_BASE/api/open/marketplace/skills/$SKILL_ID")
printf '%s' "$RESP" | jq -e '.success == true' >/dev/null
URL=$(printf '%s' "$RESP" | jq -er '.data.item.zipUrl | select(length > 0)')
SKILL_DOWNLOAD_DIR=$(mktemp -d)
SKILL_ZIP="$SKILL_DOWNLOAD_DIR/skill.zip"
curl -fsSL --proto '=http,https' -o "$SKILL_ZIP" "$URL"
unzip -t "$SKILL_ZIP"
# 先检查包内路径、SKILL.md 与版本，再安装；发布验证还要比对预期文件内容。
unzip -l "$SKILL_ZIP"
# 装到「项目级」技能目录，不是用户主目录 —— 技能跟着项目的版本库走，
# 团队每个人 clone 下来都有；装到 ~ 的话，人一走团队什么都不剩。
# 宿主识别与 CDS 初始化脚本同一套约定，两条路装到同一个地方，不会分裂成两处技能库。
# 装到项目级，且**存在几个宿主就装几个**。
# 一个仓库可能同时装了多个 Agent（比如同时有 .claude 和 .agents）：
# 只装第一个命中的，从另一个 Agent 跑就「装完了一个技能都看不见」。
SKILLS_DIRS=""
for h in .claude .agents; do
  [ -d "$h" ] && SKILLS_DIRS="$SKILLS_DIRS $h/skills"
done
[ -n "$SKILLS_DIRS" ] || SKILLS_DIRS=".agents/skills"   # 一个都没有时兜底
for d in $SKILLS_DIRS; do mkdir -p "$d" && unzip -o "$SKILL_ZIP" -d "$d"; done
```

确需 fork 时使用实时工具契约，或调用 `POST /api/open/marketplace/skills/{id}/fork`，传入本次操作的稳定 `Idempotency-Key`，成功后取 `data.downloadUrl`。结果未知时先回查，不直接生成新标识重发。官方 fork 只返回官方下载地址，不累计下载数。

## 用户上传

需要 `marketplace.skills:write` scope；这是用户发布路径，官方目录维护另见参考文件。

zip 内必须含 `SKILL.md`，≤ 20 MB，上传后默认公开。

```bash
# 仅新上传生成一次，并保留在本次任务记录中；重试复用原值，不重复生成。
UPLOAD_INTENT_ID=$(python3 -c 'import uuid; print(uuid.uuid4())')
curl -sS -X POST "$PRD_AGENT_BASE/api/open/marketplace/skills/upload" "${AUTH[@]}" \
  -H "Idempotency-Key: $UPLOAD_INTENT_ID" \
  -F "file=@./my-skill.zip" \
  -F "title=我的新技能" \
  -F "description=30 字以内概述这个技能做什么" \
  -F 'tagsJson=["AI","效率"]'
```

**AI 上传时默认走幂等覆盖**：同一用户用同一 slug 反复上传 = 自动替换原条目，不要每次问用户"要不要覆盖"。slug 自动从 zip 内 `SKILL.md` 的 frontmatter `name:` 提取，所以 SKILL.md 写好 `name:` + `version:` 即可。

这是业务覆盖规则，与请求的操作标识分开：新版本上传是新操作，重试则复用原标识和原始参数。旧条目没有 slug 时，当前服务端还会按同一 owner、显式相同 title 回退匹配并补齐 slug；不是全市场按标题覆盖。

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
# 两个操作各用自己的稳定标识；同一个操作重试时保留原值。
curl -sS -X POST "$PRD_AGENT_BASE/api/open/marketplace/skills/$SKILL_ID/favorite" "${AUTH[@]}" -H "Idempotency-Key: $FAVORITE_INTENT_ID" -d '{}'
curl -sS -X POST "$PRD_AGENT_BASE/api/open/marketplace/skills/$SKILL_ID/unfavorite" "${AUTH[@]}" -H "Idempotency-Key: $UNFAVORITE_INTENT_ID" -d '{}'
```

## 订阅新技能（轮询）

```bash
CURSOR=$(cat ~/.prd-agent/last_cursor 2>/dev/null || echo "1970-01-01T00:00:00Z")
curl -sS "$PRD_AGENT_BASE/api/open/marketplace/skills?sort=new&limit=50" "${AUTH[@]}" \
  | jq --arg since "$CURSOR" '.data.items | map(select(.createdAt > $since))'
```

把结果里最新一条 `createdAt` 写回 `~/.prd-agent/last_cursor` 即可。

该时间游标只用于社区新条目发现，不是官方技能更新机制。Open API 无关键词或标签时不会注入一般官方目录技能；官方时间戳还是固定值。检查官方更新应按 key 搜索或查详情，对比 `version`，必要时下载核对内容。

## Key 过期处理

响应头会携带：
- `X-AgentApiKey-ExpiringSoon: true` + `X-AgentApiKey-DaysLeft: N` —— 30 天内过期
- `X-AgentApiKey-Expiring: true` —— 已过期但在 7 天宽限期内
- HTTP `401` —— 超过宽限期或被撤销

检测到前两种情况就提示用户：打开 `$PRD_AGENT_BASE/marketplace` → 右上角「接入 AI」→ 我的 Key → 点「续期一年」。

## 响应契约

JSON 业务接口统一结构：`{ success: bool, data: {...}, error: { code, message } | null }`。同时检查 HTTP 状态和 `success`。ZIP 端点返回二进制；HTTP 200 或下载命令退出成功不足以证明是技能包，须检查 ZIP、版本和文件内容。

## 如何更新此技能

此技能也走官方目录，随目标实例的 API 发布生效。版本唯一事实源是源码 `SKILL.md` 的 frontmatter，经生成目录进入运行中的 API；`OfficialSkillTemplates.FindMapSkillsVersion` 是读取目录的属性，不再单独维护常量。

用户要求检查更新时，按 key 搜索或查 `official-findmapskills`，与本地 frontmatter 版本比较：

```bash
set -e
RESP=$(curl -fsS "$PRD_AGENT_BASE/api/open/marketplace/skills/official-findmapskills")
printf '%s' "$RESP" | jq -e '.success == true' >/dev/null
REMOTE_VERSION=$(printf '%s' "$RESP" | jq -er '.data.item.version')
printf '远端版本: %s\n' "$REMOTE_VERSION"
# 用同一详情响应的 data.item.zipUrl 取真实包，按“下载与安装”复核。
```

确认远端更新后，更新项目里实际存在的宿主目录；软链指向同一源时更新真实源。遇到 404、`UNKNOWN_FIELD` 或工具 schema 不匹配，先核对目标实例、路由和实时工具定义，不把所有错误都当成重装信号。不因本节的检查建议自动创建定时任务。
