---
name: preview-url
description: 根据当前 Git 分支名自动生成预览验证地址。分支名中的 `/` 替换为 `-`，拼接 `.miduo.org` 域名后缀。用于需要人工验收的场景，快速提供可访问的预览环境链接。触发词："预览地址"、"验收地址"、"preview url"、"/preview"。
---

# Preview URL — 预览验收地址生成

根据当前 Git 分支名自动生成预览环境的访问地址，便于人工验收。

## 触发词

- "预览地址"
- "验收地址"
- "preview url"
- `/preview`

## URL 生成规则

```
分支名: claude/fix-safari-article-display-yyusg
       ↓ 将 `/` 替换为 `-`
前缀:   claude-fix-safari-article-display-yyusg
       ↓ 拼接域名后缀
URL:    https://claude-fix-safari-article-display-yyusg.miduo.org/
```

## 执行流程

### Step 1: 获取当前分支名

```bash
git branch --show-current
```

### Step 2: 生成预览 URL

将分支名中的 `/` 替换为 `-`，拼接 `https://` 前缀和 `.miduo.org/` 后缀。

### Step 3: 输出结果

输出格式：

```markdown
**预览验收地址**: https://{branch-slug}.miduo.org/

> 分支: `{branch-name}`
```

如果涉及具体页面路径（从交接清单或上下文中获取），同时输出完整的验收路径：

```markdown
**预览验收地址**: https://{branch-slug}.miduo.org/

**验收路径**:
1. 打开 https://{branch-slug}.miduo.org/{page-path}
2. {具体验收步骤}
```

## 注意事项

1. 分支名为空时（detached HEAD），提示用户先切换到功能分支
2. 仅替换 `/` 为 `-`，其他字符保持不变
3. 此技能可被 `/handoff` 自动调用，也可单独使用
