#!/bin/bash
# 设置 Git Hooks - 自动验证提交
#
# 用法: ./scripts/setup-hooks.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"
HOOKS_DIR="$(git rev-parse --git-path hooks)"
mkdir -p "$HOOKS_DIR"

echo "设置 Git Hooks..."

# 创建 pre-commit hook
cat > "$HOOKS_DIR/pre-commit" << 'EOF'
#!/bin/bash
# Pre-commit hook: 快速验证

echo "[pre-commit] 开始检查..."

# 获取暂存的文件
STAGED_CS=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.cs$' || true)
STAGED_TS=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.(ts|tsx)$' || true)
STAGED_CHANGELOGS=$(git diff --cached --name-only --diff-filter=ACM -- 'changelogs/*.md' || true)

if [ -n "$STAGED_CHANGELOGS" ]; then
    echo "  检查 changelog 碎片..."
    ./scripts/validate-changelog-fragments.sh
    if [ $? -ne 0 ]; then
        echo "[pre-commit] changelog 碎片检查失败"
        exit 1
    fi
fi

# 如果有 C# 文件变更，运行编译检查
if [ -n "$STAGED_CS" ]; then
    echo "  检查 C# 文件..."
    if command -v dotnet &> /dev/null; then
        cd prd-api
        dotnet build PrdAgent.sln -c Release --verbosity quiet 2>&1 | tail -2
        if [ $? -ne 0 ]; then
            echo "[pre-commit] C# 编译失败"
            exit 1
        fi
        cd ..
    fi
fi

# 如果有 TypeScript 文件变更，运行类型检查
if [ -n "$STAGED_TS" ]; then
    echo "  检查 TypeScript 文件..."
    if command -v pnpm &> /dev/null; then
        cd prd-admin
        pnpm tsc --noEmit 2>&1 | tail -2
        if [ $? -ne 0 ]; then
            echo "[pre-commit] TypeScript 类型检查失败"
            exit 1
        fi
        cd ..
    fi
fi

echo "[pre-commit] 检查通过"
EOF

chmod +x "$HOOKS_DIR/pre-commit"

# 创建 commit-msg hook
cat > "$HOOKS_DIR/commit-msg" << 'EOF'
#!/bin/bash
# Commit-msg hook: 提交标题格式检查

./scripts/validate-commit-msg.sh "$1"
EOF

chmod +x "$HOOKS_DIR/commit-msg"

echo "✓ Git hooks 已设置"
echo ""
echo "现在每次 commit 前会自动运行基础检查，并校验 commit message。"
echo "如需跳过检查，使用: git commit --no-verify"
