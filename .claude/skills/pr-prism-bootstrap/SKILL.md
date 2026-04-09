---
name: pr-prism-bootstrap
description: 一键初始化新仓库的 PR 审查棱镜依据（最薄顶层设计 + 绑定配置）。触发词："pr prism bootstrap"、"初始化审查棱镜"、"bootstrap prism"。
---

# PR Review Prism Bootstrap

用于在新项目/新仓库中，以最低配置成本初始化 PR 审查棱镜可运行基线。

## 触发词

- "pr prism bootstrap"
- "初始化审查棱镜"
- "bootstrap prism"
- "初始化顶层设计基线"

## 目标

一次执行完成以下结果：

1. 生成最薄顶层设计文档与 manifests（`doc/top-design/*`）。
2. 生成并激活本仓库设计源（`.github/pr-architect/design-sources.yml`）。
3. 写入当前仓库绑定（`.github/pr-architect/repo-bindings.yml`）。
4. 让 `setup-status` 能识别为顶设基线已就绪（在 GitHub Token 已配置前提下）。

## 执行步骤（必须顺序）

### Step 1: 使用最小两文件包执行零参数初始化

推荐把以下 2 个文件复制到目标仓库：

- `scripts/bootstrap-pr-prism.sh`
- `scripts/init-pr-prism-basis.sh`

优先使用零参数命令：

```bash
bash scripts/bootstrap-pr-prism.sh
```

脚本会自动探测：

- repo：优先 `git remote origin`，失败回退 `gh repo view`，再回退 `git config github.repo`
- owner/architect：优先 `gh api user`，失败回退 `git config user.name`

### Step 2: 文件存在性检查

确认以下文件已生成：

- `doc/top-design/main.md`
- `doc/top-design/anchors.yml`
- `doc/top-design/contexts.yml`
- `doc/top-design/slices.yml`
- `.github/pr-architect/design-sources.yml`
- `.github/pr-architect/repo-bindings.yml`

### Step 3: 最小自检

```bash
bash -n scripts/bootstrap-pr-prism.sh
bash -n scripts/init-pr-prism-basis.sh
python3 -m py_compile .github/scripts/pr_architect_check.py
```

### Step 4: 建议验收动作

1. 提交并推送变更；
2. 配置分支保护 required check：`PR审查棱镜 L1 Gate`；
3. 创建示例 PR 验证 prefill/check/publish 流程。

## 成功标准（DoD）

- `design-sources.yml` active source 不再是 bootstrap 占位；
- `repo-bindings.yml` 有当前仓库条目；
- `anchors.yml` 至少 1 个 anchor；
- PR 页面中的配置检查不再提示“顶层设计待初始化”。

## 失败兜底

如果自动探测失败，改用显式参数：

```bash
bash scripts/bootstrap-pr-prism.sh --repo "owner/repo" --owner "your-github-id" --context "engineering-governance"
```
