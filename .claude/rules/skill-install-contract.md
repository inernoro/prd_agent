# 技能分发与安装约定（Skill Install Contract）

> 技能装到哪、谁负责发现、谁负责安装——这三件事必须全系统一个口径。
> 触发：改动任何「教用户或 AI 安装技能」的地方（技能 SKILL.md、CDS 引导脚本、MAP 官方技能端点、市场 UI 的安装命令）。

---

## 一、安装位置：项目级优先，不写用户主目录

```sh
if   [ -d ".claude" ]; then SKILLS_DIR=".claude/skills"   # Claude Code
elif [ -d ".cursor" ]; then SKILLS_DIR=".cursor/skills"   # Cursor
else                        SKILLS_DIR=".agents/skills"   # 通用 Agent Skills / Codex
fi
```

**为什么不是 `~/.claude/skills`**：帮别人建系统时，技能装在你这台机器上，人一走团队什么都不剩。装项目级则技能跟着对方的版本库走，全队 clone 下来都有。

**为什么不能写死 `.claude`**：Cursor 和 Codex 宿主直接就是错的目录。

## 二、三处实现必须同步

跨语言无法共享代码，只能靠守卫测试钉在一起：

| 实现 | 位置 |
|---|---|
| CDS 引导脚本 | `cds/src/routes/bootstrap.ts` |
| findmapskills 技能 | `.claude/skills/findmapskills/SKILL.md` + `README.md` |
| MAP 后端（套装安装命令、INSTALL.md） | `prd-api/.../OfficialSkills/SkillInstallContract.cs` |

守卫：`cds/tests/services/skill-install-contract.test.ts`。改探测顺序或默认层级，三处必须一起改，否则 CI 红。

## 三、发现与安装的职责边界

两条路，**职责不同，不许互相重复实现**：

| 场景 | 走哪条 | 凭据 |
|---|---|---|
| 从零把项目立起来，装齐一个角色的全套 | CDS「项目初始化」 | 匿名 |
| 浏览有哪些官方套装、各含什么技能 | CDS「海鲜市场」栏 / `GET /api/skills/bundles` | 匿名 |
| 搜索市场、看详情、下载单个技能 | `findmapskills` | **匿名** |
| 上传自己的技能、收藏、订阅 | `findmapskills` | 要 API Key |

**读技能一律免凭据**（2026-07-28 用户决策）：技能是公开内容，把浏览和下载挡在凭据后面
等于要求客户先注册才能拿技能。列表 / 详情 / 标签 / 下载全部匿名，查询恒带 `IsPublic` 过滤；
只有上传和「绑定到人」的收藏订阅要 Key。AI 不得因为没有 Key 就停下来问用户——直接搜、直接下。

CDS 只做「浏览 + 按预设装」，数据从 MAP 代理并带缓存兜底；要身份的操作一律走 `findmapskills`。
**CDS 不实现搜索和上传**，MAP 不实现引导脚本。

## 四、技能内容的单一事实源

技能正文只有一份：`.claude/skills/<key>/`。后端不得内嵌第二份副本。

需要按实例定制的部分（如 base URL），走**下载时一处替换**，不是维护第二份正文：

- `findmapskills`：技能文件用 `$PRD_AGENT_BASE` 写，下发时把它的默认值设为该实例地址
- `ai-defect-resolve`：仍走 `OfficialSkillTemplates` 内嵌模板（尚未迁移，见下）

守卫会拒绝重新引入 `FindMapSkillsSkillMd` / `FindMapSkillsReadme` 这类内嵌常量。

## 五、历史背景

2026-07-28 用户指出「findmapskills 和 CDS 侧不是一个 SSOT 可能会导致问题」。核实后发现已经在打架：

1. `findmapskills`（两份拷贝都是）教用户装 `~/.claude/skills/`，写死 `.claude`；CDS 引导脚本装项目级三宿主——同一个客户项目会分裂出两处技能库
2. `findmapskills` 正文存在两份（`.claude/skills/` 一份、`OfficialSkillTemplates.cs` 一份），注释写着需要人工同步，实测已开始漂移
3. MAP 套装自己的 `installCommand` 和 `INSTALL.md` 也写着 `~/.claude/skills/`

三条同一批修复，并加守卫测试防复发。

## 六、待办

`ai-defect-resolve` 仍是后端内嵌模板，是最后一个双份来源。迁移方式与 findmapskills 相同（进 catalog + 下载时替换占位），未做的原因是它有 `{{VERSION}}` / `{{RELEASE_DATE}}` 占位需要一并处理。
