---
name: preview-url
description: 根据当前 Git 仓库根目录名(项目 slug)和分支名,自动生成 CDS 多项目预览验收地址。格式:`https://${projectSlug}-${branchSlug}.miduo.org/`。两个 slug 都做小写化 + 非 alnum-hyphen 替换。用于需要人工验收的场景,快速提供可访问的预览环境链接。触发词:"预览地址"、"验收地址"、"preview url"、"/preview"。
---

# Preview URL — 预览验收地址生成

根据当前 Git **仓库根目录名(项目 slug)** 和 **分支名(分支 slug)**,自动生成 CDS 预览环境的访问地址,便于人工验收。

## 触发词

- "预览地址"
- "验收地址"
- "preview url"
- `/preview`

## URL 生成规则

CDS 多项目模式下(legacyFlag=false,本仓库已迁移),URL 格式为:

```
https://${projectSlug}-${branchSlug}.miduo.org/
```

> ⚠ 旧格式(legacyFlag=true / CDS 多项目改造前)只有 `${branchSlug}`,**已废弃**。任何 2026-04 之后的项目都走新格式,缺 `${projectSlug}-` 前缀就会 404 到 CDS 默认 fallback 页。

### Slug 转换规则

两个 slug 都做相同处理(对齐 `cds/src/services/state.ts` 的 `slugify`):

1. 转小写
2. 非 `[a-z0-9-]` 字符替换为 `-`
3. 合并连续 `-`
4. 去掉头尾 `-`

示例:

| 原值 | Slug |
|------|------|
| `prd_agent` (目录名) | `prd-agent` |
| `claude/add-guided-tips-dp6pP` (分支名) | `claude-add-guided-tips-dp6pp` |
| 拼接结果 | `https://prd-agent-claude-add-guided-tips-dp6pp.miduo.org/` |

## 执行流程

### Step 1: 一行 bash 直接生成

```bash
PROJECT_SLUG=$(basename "$(git rev-parse --show-toplevel)" \
  | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g; s/--*/-/g; s/^-//; s/-$//')
BRANCH_SLUG=$(git branch --show-current \
  | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g; s/--*/-/g; s/^-//; s/-$//')
echo "https://${PROJECT_SLUG}-${BRANCH_SLUG}.miduo.org/"
```

### Step 2: 输出格式

```markdown
**预览验收地址**: https://{project-slug}-{branch-slug}.miduo.org/

> 项目: `{project-slug}` · 分支: `{branch-name}`
```

如果涉及具体页面路径(从交接清单或上下文中获取),同时输出完整的验收路径:

```markdown
**预览验收地址**: https://{project-slug}-{branch-slug}.miduo.org/

**验收路径**:
1. 打开 https://{project-slug}-{branch-slug}.miduo.org/{page-path}
2. {具体验收步骤}
```

## 注意事项

1. 分支名为空时(detached HEAD),提示用户先切换到功能分支
2. 项目 slug 必须从仓库根目录派生 — **禁止 hardcode `prd-agent`** 字面量,以免在多仓库共用本技能时失效
3. 此技能可被 `/handoff` 自动调用,也可单独使用
4. **CLAUDE.md 规则 #11 强制要求**:任何代码改动 push 后,最终交付消息必须包含【预览】行(调用本技能或内联拼接)。详见 `CLAUDE.md`。
5. 如果 CDS 还在构建/部署中,URL 可能暂时返回 502/504,等 1-2 分钟即可。可在 PR 的 Checks 面板看 "CDS Deploy" check run 状态。
