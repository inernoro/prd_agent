# PR审查棱镜 Bootstrap Package（新仓库两文件接入）

目标：把新仓库接入成本降到最低，只复制 2 个文件即可执行初始化。

## 1. 包内容（仅两文件）

- `scripts/bootstrap-pr-prism.sh`
- `scripts/init-pr-prism-basis.sh`

说明：

- `bootstrap-pr-prism.sh` 是入口脚本，负责环境检查与调用；
- `init-pr-prism-basis.sh` 负责生成最薄顶层设计与绑定文件。

## 2. 在新仓库中的最小步骤

在目标仓库根目录执行：

```bash
mkdir -p scripts
cp /path/from/this-repo/scripts/bootstrap-pr-prism.sh scripts/
cp /path/from/this-repo/scripts/init-pr-prism-basis.sh scripts/
bash scripts/bootstrap-pr-prism.sh
```

如自动探测失败，可显式传参：

```bash
bash scripts/bootstrap-pr-prism.sh --repo "your-org/your-repo" --owner "your-github-id"
```

## 3. 执行后会生成

- `doc/top-design/main.md`
- `doc/top-design/anchors.yml`
- `doc/top-design/contexts.yml`
- `doc/top-design/slices.yml`
- `.github/pr-architect/design-sources.yml`
- `.github/pr-architect/repo-bindings.yml`

## 4. 验收检查

- [ ] `design-sources.yml` active source 不是 bootstrap 占位源
- [ ] `repo-bindings.yml` 包含当前仓库条目
- [ ] 能创建示例 PR，`PR审查棱镜 L1 Gate` 可执行

## 5. 后续建议

初始化完成后提交：

```bash
git add doc/top-design .github/pr-architect scripts
git commit -m "chore: bootstrap pr prism basis"
```
