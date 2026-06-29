---
name: preview-url
description: 调 cdscli 生成当前分支的 CDS v3 预览验收地址。零参数，自动从 git + /api/branches 拿真实 previewSlug。所有 slug 与 host 拼接都由 cdscli 一口井负责，AI / 任何 skill 一律不得自己 slugify。触发词:"预览地址"、"验收地址"、"preview url"、"/preview"。
---

# 预览验收地址生成

> **版本**：v1.0.0 | **状态**：已落地 | **触发**：`/preview`、"预览地址"、"验收地址"、"preview url" | **SSOT**：`cds/src/services/preview-slug.ts:computePreviewSlug`

唯一执行入口：

```bash
python3 .claude/skills/cds/cli/cdscli.py --human preview-url
```

零参数。自动检测 git 分支 + 仓库根 + （可选）CDS_HOST/AI_ACCESS_KEY。输出一行 URL 到 stdout，直接复制到给用户的回复里即可。

## 触发词

- "预览地址" / "验收地址" / "preview url" / `/preview`

## 为什么强制走 cdscli（不要自己 slugify）

**SSOT**：`cds/src/services/preview-slug.ts:computePreviewSlug`（v3 公式 = `${tail}-${prefix}-${projectSlug}.miduo.org`）。

`cdscli preview-url` 的内部决策：

1. **CDS API 优先**：有 `CDS_HOST` + `AI_ACCESS_KEY` → `GET /api/branches` 找 `branch == 当前 git 分支`，直接读后端算好的 `previewSlug` 字段（与 SSOT 永不漂）
2. **本地 v3 fallback**：没 CDS 凭据 / 分支没在 CDS / API 异常 → 走 cdscli 内嵌的 `_compute_preview_slug()`（与 SSOT 同公式，目录名 slugify 当 project slug）
3. **失败**：不在 git 仓库内 / detached HEAD → exit 1，提示切分支

**任何 skill / 文档 / commit message 都不得**：
- 手写 `tr '/' '-'` / 在脑子里 slugify
- 拼 `${BRANCH_ID}.miduo.org`（v1 老公式）
- 拼 `${projectSlug}-${branchSlug}.miduo.org`（v2 老公式）
- 写自己的 Python `slugify` 函数

## 历史公式（CDS proxy 兼容旧链接，但**新生成**一律 v3）

- v1（2026-04 之前）：`${branchSlug}.miduo.org` — legacy
- v2（2026-04-26 ceb2c01）：`${projectSlug}-${branchSlug}.miduo.org`
- **v3（2026-04-27 起，当前）**：`${tail}-${prefix}-${projectSlug}.miduo.org`（重要的靠前）

## 示例

| 分支 | 项目目录 | `cdscli preview-url` 输出 |
|------|---------|---------|
| `claude/fix-refresh-error-handling-2Xayx` | `prd_agent` | `https://fix-refresh-error-handling-2xayx-claude-prd-agent.miduo.org/` |
| `feat/auth/login` | `demo` | `https://auth-login-feat-demo.miduo.org/` |
| `main` | `prd_agent` | `https://main-prd-agent.miduo.org/`（中段省略） |

## 输出格式（回复里这样贴）

```markdown
**预览验收地址**: <cdscli 输出原文>

> 项目: `{project-slug}` · 分支: `{branch-name}`
```

涉及具体页面路径时：

```markdown
**预览验收地址**: <cdscli 输出原文>

**验收路径**:
1. 打开 <cdscli 输出原文>{page-path}
2. {具体验收步骤}
```

## 注意事项

1. **CLAUDE.md 规则 #11 强制要求**：代码 push 后交付消息必须含【预览】行，统一调本技能
2. CDS 还在构建/部署中时 URL 可能 502/504/400，等 1-2 分钟即可；在 PR Checks 面板看 "CDS Deploy" 状态
3. 用户外发的 v1/v2 旧链接 CDS proxy 仍兼容；但你**新生成**的一律走 cdscli（=v3）
