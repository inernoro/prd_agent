# PR审查棱镜新仓库初始化指南（最小可用）

本文档用于回答两个问题：

1. 新项目/新仓库如何初始化“PR 审查依据”（顶层设计、锚定项、上下文、切片）。
2. 如何用最薄文档快速落地，让 Gate 不再依赖 bootstrap 占位配置。

## 1. 背景与目标

PR审查棱镜在 V1 阶段要求：

- `design_source_id/design_source_version` 可解析
- `anchor_refs` 能在 active design source 的 anchors manifest 中找到
- 仓库必须在 `repo-bindings.yml` 里声明绑定

如果仓库仍使用 `.github/pr-architect/top-design.bootstrap.md` 占位设计源，会被 Gate 阻断。

## 2. 一条命令初始化（推荐）

在仓库根目录执行：

```bash
bash scripts/init-pr-prism-basis.sh --repo "your-org/your-repo" --owner "your-github-id"
```

脚本会：

1. 生成最薄顶层设计文档（`doc/top-design/main.md`）
2. 生成最薄 manifests：
   - `doc/top-design/anchors.yml`
   - `doc/top-design/contexts.yml`
   - `doc/top-design/slices.yml`
3. 生成/更新 `.github/pr-architect/design-sources.yml` 为本仓库本地 design source
4. 在 `.github/pr-architect/repo-bindings.yml` 中为当前仓库补充绑定项
5. 打印后续手工确认项

## 3. 薄文档最小结构

以下 4 个文件是最小可用组合：

- `doc/top-design/main.md`
- `doc/top-design/anchors.yml`
- `doc/top-design/contexts.yml`
- `doc/top-design/slices.yml`

### 3.1 anchors.yml（至少 1 条）

```yaml
version: 1
anchors:
  - id: "ANCHOR-CORE-01"
    title: "核心架构约束"
    description: "新增功能必须与声明的 bounded context 对齐"
```

### 3.2 contexts.yml（至少 1 条）

```yaml
version: 1
contexts:
  - id: "engineering-governance"
    name: "engineering-governance"
    description: "工程治理上下文"
```

### 3.3 slices.yml（至少 1 条）

```yaml
version: 1
slices:
  - id: "governance-bootstrap"
    owner: "architect"
    context: "engineering-governance"
    description: "初始化治理切片"
```

## 4. 新仓库接入清单

- [ ] 运行初始化脚本：`bash scripts/init-pr-prism-basis.sh --repo "your-org/your-repo" --owner "your-github-id"`
- [ ] 提交生成文件到仓库
- [ ] 在 GitHub 分支保护中配置 required check：`PR审查棱镜 L1 Gate`
- [ ] 创建一个测试 PR，确认：
  - prefill 工作流能填入 `design_source_id/design_source_version`
  - check 工作流通过或返回可解释阻断信息
  - publish 工作流能更新单条决策卡评论

## 5. 常见问题

### Q1：为什么 URL/artifact 设计源没法直接用？

V1 Gate 对 anchors 校验只支持 repo-file manifests。URL/artifact 的 anchors 在 V1 会被阻断，这是有意的可控范围收敛。

### Q2：我可以先用最薄文档，后面再替换成完整顶设吗？

可以。建议先保证 Gate 跑通，再增量替换 `doc/top-design/*` 的内容和 `checksum/version`。

### Q3：如何判断自己还在用 bootstrap 占位源？

如果 `design-sources.yml` 的 active source 指向：

- id 含 `bootstrap`
- location 指向 `top-design.bootstrap.md`
- checksum 含 `bootstrap-replace`

都会被当前 Gate 直接阻断。
