#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
solution_file="$repo_root/prd-api/PrdAgent.sln"
failed=0
discovered=0

while IFS= read -r project_file; do
  if ! rg -q 'Microsoft\.NET\.Test\.Sdk|xunit|NUnit|MSTest' "$project_file"; then
    continue
  fi

  discovered=$((discovered + 1))
  relative="${project_file#"$repo_root/"}"
  project_name="$(basename "$project_file")"

  if ! rg -q '<IsTestProject>\s*true\s*</IsTestProject>' "$project_file"; then
    echo "测试项目缺少 <IsTestProject>true</IsTestProject>: $relative" >&2
    failed=1
  fi

  if ! rg -q "$(printf '%s' "$project_name" | sed 's/[.[\\*^$()+?{|]/\\&/g')" "$solution_file"; then
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
