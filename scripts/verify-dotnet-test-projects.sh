#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
solution_file="$repo_root/prd-api/PrdAgent.sln"
failed=0
discovered=0

while IFS= read -r project_file; do
  # GitHub runner 不保证安装 ripgrep。该门禁必须在最小 POSIX 工具集下运行，
  # 否则“验证测试发现”本身会在测试启动前误报零项目。
  if ! grep -Eq 'Microsoft\.NET\.Test\.Sdk|xunit|NUnit|MSTest' "$project_file"; then
    continue
  fi

  discovered=$((discovered + 1))
  relative="${project_file#"$repo_root/"}"
  project_name="$(basename "$project_file")"

  if ! grep -Eq '<IsTestProject>[[:space:]]*true[[:space:]]*</IsTestProject>' "$project_file"; then
    echo "测试项目缺少 <IsTestProject>true</IsTestProject>: $relative" >&2
    failed=1
  fi

  if ! grep -Fq "$project_name" "$solution_file"; then
    echo "测试项目未纳入 prd-api/PrdAgent.sln: $relative" >&2
    failed=1
  fi
done < <(find "$repo_root" \
  -path '*/node_modules' -prune -o \
  -path '*/obj' -prune -o \
  -path '*/bin' -prune -o \
  -name '*.csproj' -print)

if [ "$discovered" -eq 0 ]; then
  echo "未发现任何 .NET 测试项目，拒绝以零测试通过" >&2
  exit 1
fi

if [ "$failed" -ne 0 ]; then
  exit 1
fi

echo "已验证 $discovered 个 .NET 测试项目：均显式启用 IsTestProject 且已纳入解决方案"
