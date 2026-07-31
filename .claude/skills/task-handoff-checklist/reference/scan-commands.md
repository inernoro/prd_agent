# 通用交接扫描命令

以下命令用于取证。先把 `<base>` 替换为动态发现的默认分支，不要直接假定分支名。

```bash
git symbolic-ref --quiet --short refs/remotes/origin/HEAD
git merge-base HEAD <base>
git diff --name-status <base>...HEAD
git diff --stat <base>...HEAD
git status --short
```

## 发现仓库约定

```bash
find .. -name AGENTS.md -o -name CLAUDE.md -o -name CODEOWNERS
find . -maxdepth 3 \( -name package.json -o -name pyproject.toml -o -name Cargo.toml -o -name go.mod -o -name '*.sln' \)
find . -maxdepth 3 \( -path '*/.github/workflows/*' -o -name 'docker-compose*.yml' -o -name Dockerfile \)
```

只读取与变更目录或验证命令相关的文件，避免无边界扫描大型仓库。

## 按变更内容查证

```bash
git diff <base>...HEAD -- '*test*' '*spec*'
git diff <base>...HEAD -- '*.md'
git diff <base>...HEAD -- '*.yml' '*.yaml' 'Dockerfile*'
git diff <base>...HEAD | rg -i 'route|endpoint|schema|migration|permission|secret|token|env|deploy|rollback'
```

模式命中只是线索，不是结论。验证命令必须来自仓库规则、CI 或 manifest，不凭经验拼装。
