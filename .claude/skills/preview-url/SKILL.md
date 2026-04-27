---
name: preview-url
description: 根据当前 Git 仓库根目录名(项目 slug)和分支名,自动生成 CDS v3 预览验收地址。格式:`https://${tail}-${prefix}-${projectSlug}.miduo.org/`,重要的靠前(分支主特征 → agent 前缀 → 项目名)。所有 slug 都做小写化 + 非 alnum-hyphen 替换。用于需要人工验收的场景,快速提供可访问的预览环境链接。触发词:"预览地址"、"验收地址"、"preview url"、"/preview"。
---

# Preview URL — 预览验收地址生成

根据当前 Git **分支名（拆 prefix/tail）** 和 **仓库根目录名（项目 slug）**,自动生成 CDS v3 预览环境的访问地址,便于人工验收。

## 触发词

- "预览地址"
- "验收地址"
- "preview url"
- `/preview`

## URL 生成规则（v3：tail-prefix-project，重要的靠前）

```
https://${tail}-${prefix}-${projectSlug}.miduo.org/
```

- `${tail}` = 分支名第一个 `/` 之后的部分（"在干啥"，最重要）
- `${prefix}` = `/` 之前的 agent / 类型前缀（claude / cursor / feat / fix）
- `${projectSlug}` = 仓库根目录名（项目身份信息，最不需要常看，所以放最后）
- 所有片段全部 slugify：转小写 + 非 `[a-z0-9-]` 替换为 `-` + 合并连续 `-` + 去头尾 `-`

⚠ **历史 URL 公式演化**（CDS proxy 仍兼容旧链接，但**新生成**一律用 v3）：
- v1（2026-04 之前）：`${branchSlug}.miduo.org`（无项目前缀）— legacy 项目
- v2（2026-04-26 ceb2c01）：`${projectSlug}-${branchSlug}.miduo.org`（项目前缀型）
- v3（2026-04-27 起）：`${tail}-${prefix}-${projectSlug}.miduo.org`（tail 靠前）

实现唯一来源：`cds/src/services/preview-slug.ts` 的 `computePreviewSlug(branch, projectSlug)`。本技能与 CDS 后端共享同一公式。

## 拆分规则

按**第一个 `/`** 切一刀：
- 有 `/`：`prefix = / 之前`，`tail = / 之后`（剩余 `/` 走 slugify 变 `-`）
- 无 `/`：无 prefix，URL 中段省略，输出 `${tail}-${projectSlug}`
- prefix 经 slugify 后为空（如分支以 `/` 开头）：fallback 到无 prefix 形式

## 示例

| 分支 | 项目目录 | 拆解 | URL |
|------|---------|------|-----|
| `claude/fix-refresh-error-handling-2Xayx` | `prd_agent` | tail=`fix-refresh-error-handling-2xayx`, prefix=`claude`, project=`prd-agent` | `https://fix-refresh-error-handling-2xayx-claude-prd-agent.miduo.org/` |
| `claude/add-guided-tips-dp6pP` | `prd_agent` | tail=`add-guided-tips-dp6pp`, prefix=`claude`, project=`prd-agent` | `https://add-guided-tips-dp6pp-claude-prd-agent.miduo.org/` |
| `feat/login` | `demo` | tail=`login`, prefix=`feat`, project=`demo` | `https://login-feat-demo.miduo.org/` |
| `feat/auth/login` | `demo` | tail=`auth-login`（剩余 `/` 变 `-`）, prefix=`feat`, project=`demo` | `https://auth-login-feat-demo.miduo.org/` |
| `main` | `prd_agent` | tail=`main`, **无 prefix**, project=`prd-agent` | `https://main-prd-agent.miduo.org/` |

## 执行流程

### Step 1: bash 直接生成（v3 公式）

```bash
slugify() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g; s/--*/-/g; s/^-//; s/-$//'
}
PROJECT_SLUG=$(slugify "$(basename "$(git rev-parse --show-toplevel)")")
BRANCH=$(git branch --show-current)
case "$BRANCH" in
  */*)
    PREFIX=$(slugify "${BRANCH%%/*}")
    TAIL=$(slugify "${BRANCH#*/}")
    SLUG="${TAIL}-${PREFIX}-${PROJECT_SLUG}"
    ;;
  *)
    SLUG="$(slugify "$BRANCH")-${PROJECT_SLUG}"
    ;;
esac
echo "https://${SLUG}.miduo.org/"
```

### Step 2: 输出格式

```markdown
**预览验收地址**: https://{tail}-{prefix}-{project-slug}.miduo.org/

> 项目: `{project-slug}` · 分支: `{branch-name}`
```

如果涉及具体页面路径（从交接清单或上下文中获取），同时输出完整的验收路径：

```markdown
**预览验收地址**: https://{tail}-{prefix}-{project-slug}.miduo.org/

**验收路径**:
1. 打开 https://{tail}-{prefix}-{project-slug}.miduo.org/{page-path}
2. {具体验收步骤}
```

## 注意事项

1. 分支名为空时（detached HEAD），提示用户先切换到功能分支
2. 项目 slug 必须从仓库根目录派生 — **禁止 hardcode `prd-agent`** 字面量，以免在多仓库共用本技能时失效
3. 此技能可被 `/handoff` 自动调用，也可单独使用
4. **CLAUDE.md 规则 #11 强制要求**：任何代码改动 push 后，最终交付消息必须包含【预览】行（调用本技能或内联拼接）。详见 `CLAUDE.md`。
5. 如果 CDS 还在构建/部署中，URL 可能暂时返回 502/504/400，等 1-2 分钟即可。可在 PR 的 Checks 面板看 "CDS Deploy" check run 状态。
6. **v1/v2 旧链接仍可解析**：用户外发的旧格式 URL（`${branchSlug}.miduo.org` / `${projectSlug}-${branchSlug}.miduo.org`）CDS proxy 兼容继续可用——但你**新生成**的链接一律用 v3。
