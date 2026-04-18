#!/usr/bin/env bash
# sync-cursor-rules.sh
# 将 .claude/rules/ 作为唯一事实源，生成 .cursor/rules/*.mdc
#
# Cursor 规则目录历史上独立维护，容易与 Claude 规则漂移（曾发生过 role 枚举、
# appKey、doc 路径、LlmRequestContext 要求全部过时的事故）。
# 执行此脚本后 .cursor/rules/ 会被完全重建，请勿手工编辑 .mdc 文件。
#
# 用法: bash scripts/sync-cursor-rules.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/.claude/rules"
DST="$REPO_ROOT/.cursor/rules"

if [ ! -d "$SRC" ]; then
  echo "[ERROR] 源目录不存在: $SRC" >&2
  exit 1
fi

echo "[INFO] 清空 $DST"
rm -rf "$DST"
mkdir -p "$DST"

# 规则 → frontmatter 映射表
# 格式: "rule-name|frontmatter-yaml"
# alwaysApply=true 的规则会始终出现在 Cursor 上下文里，仅限"高频核心"
# glob 规则只在匹配文件被编辑时加载，适合大部分架构规范
# description-only 规则仅在 AI 判断相关时加载，适合场景化规则
RULES=(
  "ai-model-visibility|globs: prd-api/src/**/*.cs,prd-admin/src/**/*.tsx,prd-desktop/src/**/*.tsx|AI 模型可见性 —— UI 必须展示当前调用的模型名"
  "app-identity|globs: prd-api/src/**/*.cs|应用身份隔离 —— Controller 硬编码 appKey，8 个应用标识"
  "bridge-ops|globs: cds/src/**/*.ts|Page Agent Bridge 操作规范：鼠标轨迹 + spa-navigate + description 必填"
  "cds-first-verification|alwaysApply: true|CDS 优先验证：本地无 SDK ≠ 无法验证，禁止把验证负担转嫁给用户"
  "codebase-snapshot|alwaysApply: true|代码库快照：架构模式、功能注册表、115 个 MongoDB 集合、已废弃概念"
  "data-audit|globs: prd-api/src/**/Models/**/*.cs,prd-api/src/**/Controllers/**/*.cs|数据关系审计：新增实体引用时必须审计所有消费端点"
  "doc-types|globs: doc/**/*.md|doc/ 下文档 6 种类型前缀（spec/design/plan/rule/guide/report）"
  "e2e-verification|alwaysApply: true|端到端验收：API 200 不等于功能正常，必须打开真实页面逐项核查"
  "enum-ripple-audit|globs: prd-api/src/**/Enums/**/*.cs,prd-admin/src/types/**/*.ts,prd-desktop/src/types/**/*.ts|枚举/常量扩展涟漪审计：全栈 6 层同步"
  "frontend-architecture|globs: prd-admin/src/**/*.{ts,tsx},prd-desktop/src/**/*.{ts,tsx}|前端架构：无业务状态 + SSOT + 注册表 + 统一 Loader + 默认可编辑"
  "frontend-modal|globs: prd-admin/src/**/*.tsx,prd-desktop/src/**/*.tsx|模态框 3 硬约束：inline style 高度 + createPortal + min-h:0"
  "gesture-unification|description: 2D 画布手势统一：两指平移 + 双指捏合/⌘+滚轮缩放，禁止双击缩放|画布手势统一原则"
  "guided-exploration|globs: prd-admin/src/**/*.{ts,tsx},prd-desktop/src/**/*.{ts,tsx}|陌生页面 3 秒内知道做什么：空状态引导 + 首次使用引导 + 操作提示"
  "llm-gateway|alwaysApply: true|LLM Gateway 统一调用规则 + LlmRequestContext.UserId 必填 + 流式场景陷阱"
  "marketplace|description: 配置发布到海鲜市场时使用 CONFIG_TYPE_REGISTRY + IForkable 白名单复制|海鲜市场扩展指南"
  "navigation-registry|alwaysApply: true|新 Agent 默认注册百宝箱 + 带 wip:true + 交付必须声明位置和点击路径"
  "no-auto-index|globs: prd-api/src/**/*.cs|禁止应用启动时自动创建 MongoDB 索引"
  "no-localstorage|globs: prd-admin/src/**/*.{ts,tsx},prd-desktop/src/**/*.{ts,tsx}|禁止使用 localStorage，统一 sessionStorage"
  "no-rootless-tree|alwaysApply: true|无根之木禁令 + 借用法则：不假定不存在的能力，缺什么借什么"
  "quickstart-zero-friction|description: 编写 init/quickstart/setup 脚本或 Dockerfile 时遵守|快速启动零摩擦原则：依赖自动检查 + 交互式安装"
  "server-authority|globs: prd-api/src/**/*.cs|服务器权威性：CancellationToken.None + Run/Worker + SSE 心跳"
  "snapshot-fallback|globs: prd-api/src/**/Controllers/**/*.cs,prd-api/src/**/Services/**/*.cs|快照反规范化兜底：Fallback 字段必须与 Snapshot 完全对齐"
  "zero-friction-input|globs: prd-admin/src/**/*.{ts,tsx},prd-desktop/src/**/*.{ts,tsx}|输入零摩擦：能上传不让用户手输，不确定就两个都给"
)

STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
GENERATED=0
MISSING=0

for entry in "${RULES[@]}"; do
  IFS='|' read -r name frontmatter description <<< "$entry"
  src_file="$SRC/$name.md"
  dst_file="$DST/$name.mdc"

  if [ ! -f "$src_file" ]; then
    echo "[WARN] 源文件缺失: $src_file"
    MISSING=$((MISSING + 1))
    continue
  fi

  # 去掉源文件已有的 YAML frontmatter（Claude 规则也可能有 globs）
  body="$(awk 'BEGIN{skip=0} NR==1 && $0=="---" {skip=1; next} skip==1 && $0=="---" {skip=0; next} skip==0 {print}' "$src_file")"

  {
    echo "---"
    # frontmatter 可以是 alwaysApply / globs / description 三种之一
    printf '%s\n' "$frontmatter"
    printf 'description: %s\n' "$description"
    echo "---"
    echo ""
    echo "<!-- 本文件由 scripts/sync-cursor-rules.sh 自动生成，请勿直接编辑。"
    echo "     事实源: .claude/rules/$name.md"
    echo "     生成时间: $STAMP -->"
    echo ""
    printf '%s\n' "$body"
  } > "$dst_file"

  GENERATED=$((GENERATED + 1))
done

# 生成索引文件，让 AI 知道事实源关系
cat > "$DST/_index.mdc" <<EOF
---
alwaysApply: true
description: Cursor 规则索引 + 与 Claude 规则的事实源关系
---

<!-- 本文件由 scripts/sync-cursor-rules.sh 自动生成，请勿直接编辑。 -->

# PRD Agent — Cursor 规则索引

## 事实源（重要）

**所有 \`.cursor/rules/*.mdc\` 都是从 \`.claude/rules/*.md\` 自动生成的镜像**。
禁止直接编辑 \`.cursor/rules/\` 下的 \`.mdc\` 文件——改动会在下次同步时被覆盖。

- 修改规则 → 编辑 \`.claude/rules/<name>.md\`
- 重新生成 → 跑 \`bash scripts/sync-cursor-rules.sh\`
- 规则索引 + 触发范围 → 见项目根 \`CLAUDE.md\` 的"架构规则索引"表格

## 必读

1. \`CLAUDE.md\`（项目根）—— 9 条强制规则 + 技能链全图
2. \`.claude/rules/codebase-snapshot.md\`—— 功能状态速查 + 115 个 MongoDB 集合
3. \`.claude/rules/llm-gateway.md\`—— LLM 调用硬约束（含 LlmRequestContext.UserId 必填）

## 已废弃概念（禁止再引用）

| 废弃 | 替代 |
|------|------|
| Guide / GuideController | Prompt Stages |
| Provider | Platform |
| ImageMaster（代码层） | VisualAgent |
| 直接 SSE 流 | Run/Worker + afterSeq |
| IEEE 830-1998 | ISO/IEC/IEEE 29148:2018 |
| SmartModelScheduler | ILlmGateway + ModelResolver |
| localStorage | sessionStorage |
| npm / yarn | pnpm only |
EOF

echo ""
echo "[OK] 生成 $GENERATED 条规则到 $DST"
if [ "$MISSING" -gt 0 ]; then
  echo "[WARN] $MISSING 条规则源文件缺失"
  exit 2
fi
