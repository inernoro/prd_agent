#!/bin/bash
# 设置 Git Hooks - 自动验证提交
#
# 用法: ./scripts/setup-hooks.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOOKS_DIR="$PROJECT_ROOT/.git/hooks"

echo "设置 Git Hooks..."

# 创建 pre-commit hook
cat > "$HOOKS_DIR/pre-commit" << 'EOF'
#!/bin/bash
# Pre-commit hook: 快速验证

echo "🔍 Pre-commit 检查..."

# 获取暂存的文件
STAGED_CS=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.cs$' || true)
STAGED_TS=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.(ts|tsx)$' || true)

# 如果有 C# 文件变更，运行编译检查
if [ -n "$STAGED_CS" ]; then
    echo "  检查 C# 文件..."
    if command -v dotnet &> /dev/null; then
        cd prd-api
        dotnet build PrdAgent.sln -c Release --verbosity quiet 2>&1 | tail -2
        if [ $? -ne 0 ]; then
            echo "❌ C# 编译失败"
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
            echo "❌ TypeScript 类型检查失败"
            exit 1
        fi
        cd ..
    fi
fi

echo "✅ Pre-commit 检查通过"
EOF

chmod +x "$HOOKS_DIR/pre-commit"

echo "✓ Git hooks 已设置"
echo ""
echo "现在每次 commit 前会自动运行基础检查。"
echo "如需跳过检查，使用: git commit --no-verify"
