# findmapskills 技能包

PrdAgent 海鲜市场的官方操作技能。装上之后 AI 就能帮你搜索 / 下载 / 上传 / 订阅市场里的技能。

版本见 `SKILL.md` 头部的「版本」行。最新版下载：`$PRD_AGENT_BASE/api/official-skills/findmapskills/download`
（`$PRD_AGENT_BASE` 在下发的技能包里已经预置成实际地址，无需自己设）。

## 安装到哪

**装到项目级技能目录，不是用户主目录。** 技能跟着项目的版本库走，团队每个人 clone 下来都有；
装到 `~` 的话，人一走团队什么都不剩。宿主识别与 CDS 初始化脚本同一套约定：

```bash
if   [ -d ".claude" ]; then SKILLS_DIR=".claude/skills"   # Claude Code
elif [ -d ".cursor" ]; then SKILLS_DIR=".cursor/skills"   # Cursor
else                        SKILLS_DIR=".agents/skills"   # 通用 Agent Skills / Codex
fi
mkdir -p "$SKILLS_DIR"
unzip -o findmapskills.zip -d "$SKILLS_DIR"
```

装完重开 AI 编程工具，说「找个海鲜市场里做 X 的技能」即可触发。

## 凭据

搜索和下载不需要凭据。**只有上传、收藏、订阅需要 API Key**：

```bash
mkdir -p ~/.codex/secrets
umask 077
printf '%s\n' '<只在页面显示一次的 Key>' > ~/.codex/secrets/prd-agent-api-key
chmod 600 ~/.codex/secrets/prd-agent-api-key
export PRD_AGENT_API_KEY="$(cat ~/.codex/secrets/prd-agent-api-key)"
```

Key 只能存在本机 secrets / Keychain / CI Secret，或当前 shell 的临时变量。
禁止写进仓库、`.claude/settings.local.json`、PR 描述、验收报告或任何公开日志。

## 与 CDS 初始化的分工

两条路都能把技能装进项目，职责不同，别混用：

| 场景 | 走哪条 |
|---|---|
| 从零把一个项目立起来（装齐一个角色需要的全套） | CDS 的「项目初始化」，匿名，一条命令 |
| 搜索市场、按需装单个技能、上传自己的技能、订阅更新 | 本技能，需要 API Key |

两边的安装目录约定完全一致，不会在同一个项目里分裂出两处技能库。

## 文档

详见同目录 `SKILL.md`。
