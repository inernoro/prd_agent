# rule.skill.trigger-disambiguation

> **类型**: rule | **状态**: active | **owner**: 平台 | **last-updated**: 2026-05-15
>
> 当多个技能围绕同一中心系统（如 CDS、Agent 工作流、视觉创作）拆分时，**触发词域必须无交集**，否则会同时命中多个技能造成误选。本文件定义触发词去重的硬规则。

## 触发的根本问题

Anthropic 官方在 [Skill Authoring Best Practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices) 强调：
- `description` 是 Claude 选技能的唯一依据
- 它会被注入到系统提示中
- 当 100+ 技能同时存在时，描述重叠 = 命中错乱

历史教训：CDS 三技能（cds / cds-deploy-pipeline / cds-project-scan）初版都接 `/cds-deploy`、`扫描项目`、`apply to cds`，AI 经常退回老技能、用错 CLI 路径。

## 强制规则

### 1. 同族技能必须遵守"动词 + 方向词"组合

裸名词（"cds"、"部署"）禁止单独作为触发词。每个触发词必须含**动词**和**方向词**：

| 维度 | 必含动词 | 必含方向词 | 示例 |
|---|---|---|---|
| 冷路径（接入 / 上传 / 注册） | 扫描 / 接入 / 生成 / 上传 / 注册 / apply / scan / register | 项目 / compose / yaml / 配置 | "**扫描**项目"、"**接入** CDS"、"apply to cds" |
| 热路径（部署 / 调试 / 看 / 修） | 部署 / 调试 / 看 / 修 / deploy / debug / logs / 诊断 | 报错 / 容器 / 灰度 / 日志 / branch | "**部署**到灰度"、"**看**容器日志"、"deploy 失败" |
| 核心 / 分诊器 | 认证 / 鉴权 / 配 / auth | 密钥 / 通行证 / 环境 / 公式 | "cds **认证**"、"**AI_ACCESS_KEY**" |

### 2. description 必须含"反向排除"

每个 SKILL.md 的 frontmatter `description` 必须包含一句 **"Does NOT handle X — those belong to {other-skill}"**。

正面例（`cds-deploy-pipeline`）：

```yaml
description: Deploys code to an existing CDS branch ... Does NOT handle
initial project onboarding, tech-stack scanning, or cds-compose.yml
generation — those belong to cds-project-scan (cold path). Does NOT
handle credential setup or CDS self-update — those belong to cds (core).
```

反向排除能显著降低 Claude 误选率（来自 Anthropic 官方建议「specific triggers/contexts」+ 排除上下文）。

### 3. slash 命令一一对应，禁止共享

```
/cds-scan        → cds-project-scan       （唯一）
/cds-deploy      → cds-deploy-pipeline    （唯一）
/cds-debug       → cds-deploy-pipeline    （别名）
/cds-smoke       → cds-deploy-pipeline    （子命令）
/cds-auth        → cds                    （唯一）
/cds             → cds                    （分诊器，见规则 4）
```

未列出的 slash 不得擅自添加。新增 slash 时必须更新本表。

### 4. 歧义触发词进双重确认

下列模糊词命中时，技能**不要立即执行命令**，先一句话反问方向：

| 模糊触发 | 反问 |
|---|---|
| 单独 "cds" / `/cds` | "您想做什么：(1) 接入新项目 (2) 调试已部署 (3) 改密钥 (4) 更新 CDS 服务" |
| 单独 "部署" | 反问"是接入新项目还是已部署的迭代部署" |
| "更新 cds" | 反问"更新 CDS 服务本体还是更新项目配置" |

明确意图（用户已说"扫描" / "deploy 失败"）→ 直接派发，**不要反问**（违反零摩擦原则）。

### 5. 共享底座代码物理去重

同族技能共用 CLI / reference 文档时，必须有**单一物理拷贝**，其他技能通过相对路径引用：

```
✅ 正确
.claude/skills/cds/cli/cdscli.py             ← 单一源
.claude/skills/cds-deploy-pipeline/SKILL.md  ← 引用 ../cds/cli/cdscli.py
.claude/skills/cds-project-scan/SKILL.md     ← 引用 ../cds/cli/cdscli.py

❌ 错误
.claude/skills/cds/cli/cdscli.py             (5553 行)
.claude/skills/cds-deploy-pipeline/cli/cdscli.py  (495 行陈旧 stub)
```

新增子技能时，**禁止**拷贝 CLI / reference，必须引用核心技能下的版本。

### 6. SKILL.md 体内必须有「处理 / 不处理」表

每个同族子技能的正文第一段必须有这样的表：

```markdown
## 本技能处理 / 不处理

| 处理 | 不处理（去对应技能） |
|---|---|
| ... | ... → 走 {other-skill} |
```

这是 description 反向排除的正文版本，让点开 SKILL.md 的用户/AI 立刻看到边界。

## 评分标准联动

`create-skill-file` 技能的 7 维度评分体系中，**Structure & Naming (15%)** 和 **Ecosystem (5%)** 维度的扣分项包括：

- description 缺反向排除 → Structure 扣 2 分
- 触发词与同族其他技能重叠 → Ecosystem 扣 3 分
- 共享底座未引用核心技能而是拷贝 → Ecosystem 扣 2 分

## 检查清单（提交新技能 / 修改触发词前）

- [ ] description 含 third-person what + when（Anthropic 官方要求）
- [ ] description 含 "Does NOT handle X — those belong to Y"
- [ ] 触发词列表无裸名词，全部 "动词 + 方向词"
- [ ] slash 命令与现有技能不冲突（grep 全仓 SKILL.md）
- [ ] SKILL.md 正文有「处理 / 不处理」表
- [ ] 共享 CLI / reference 只有单一物理拷贝
- [ ] SKILL.md body < 500 行（Anthropic 硬上限）
- [ ] 通过 `create-skill-file` 评分 ≥ 8.0/10

## 相关

- Anthropic 官方：[Skill Authoring Best Practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
- 项目评分体系：`.claude/skills/create-skill-file/SKILL.md`
- 应用范例：`.claude/skills/cds/SKILL.md`（核心 + 分诊）、`cds-project-scan` / `cds-deploy-pipeline`（冷热分离）
