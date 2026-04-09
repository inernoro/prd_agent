# Skill Template: PR Review Prism Bootstrap

目标：把“新仓库接入 PR审查棱镜”的初始化动作标准化为可复制 skill 执行模板，降低人工配置成本。

## 适用场景

- 新项目新仓库首次启用 PR审查棱镜
- 旧仓库仍处于 bootstrap 占位源，需切换为真实可校验基线

## 输入参数（建议）

- `repo`：`owner/repo`（可为空；为空时自动用 git remote 推断）
- `owner`：架构负责人 GitHub ID（可为空；为空时自动取 git user 或回退 architect）
- `context`：bounded context（默认 `engineering-governance`）

## 执行动作（必须顺序）

1. 在仓库根目录执行初始化脚本：

```bash
bash scripts/init-pr-prism-basis.sh \
  --repo "${repo:-}" \
  --owner "${owner:-}" \
  --context "${context:-engineering-governance}"
```

2. 打印并核验关键文件是否生成：
   - `doc/top-design/main.md`
   - `doc/top-design/anchors.yml`
   - `doc/top-design/contexts.yml`
   - `doc/top-design/slices.yml`
   - `.github/pr-architect/design-sources.yml`
   - `.github/pr-architect/repo-bindings.yml`

3. 执行最小自检：

```bash
bash -n scripts/init-pr-prism-basis.sh
python3 -m py_compile .github/scripts/pr_architect_check.py
```

4. 提示人工后续操作：
   - 设置分支保护 required check：`PR审查棱镜 L1 Gate`
   - 创建示例 PR 验证 prefill/check/publish 三流程

## 成功判定（DoD）

- `design-sources.yml` active source 不再是 bootstrap 占位源
- `repo-bindings.yml` 包含目标仓库条目
- `anchors.yml` 内至少有 1 个 anchor，且 PR 中可引用
- `GET /api/pr-review-prism/setup-status` 显示 `topDesign.ready = true`

## 顶层设计上传最佳实践（V1）

V1 Gate 对 anchors 校验仅支持 repo-file manifests。  
因此最佳方案是两阶段：

1. **阶段 A（立即可用）**：通过上述脚本生成仓库内薄文档并启用 gate；
2. **阶段 B（治理升级）**：将真实顶设正文放到外部系统（知识库/独立仓库/对象存储），同时把 anchors/contexts/slices 的可校验副本保留在 repo-file，更新 `design-sources.yml` 的 `location/version/checksum`。

> 说明：V1 不建议把 anchors manifest 指向 URL/artifact，否则会被 gate 阻断。

