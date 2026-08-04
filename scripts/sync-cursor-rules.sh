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
# 格式: "rule-name|frontmatter-yaml|description"
#
# 分级策略（控制 AI 上下文成本）：
# - alwaysApply=true：只留 _index.mdc（~330 tokens），其它一律不上车
# - globs:auto：编辑匹配文件时自动加载（大部分规则走这里）
# - description：AI 判断场景相关时才拉取（设计原则、偶发场景）
#
# `globs:auto` 表示作用域**从源规则的 `paths` frontmatter 派生**，本表不再手写一份。
# 这里曾经是硬编码的 glob 列表，于是同一份作用域信息被维护了两份，必然漂移：
# 2026-08-04 把 .claude/rules/enum-ripple-audit.md 的 paths 放宽到覆盖
# pages/lib 下的常量注册表后，本表仍停在 src/types，Cursor 侧照旧漏加载
# （Codex 在 PR #1324 抓出）。派生之后二者不可能再分叉。
# 只有 description 型规则仍在本表写全，因为那是 Cursor 特有的「何时拉取」触发语，
# 源规则里没有对应字段。
#
# 反面教材：别把 llm-gateway / codebase-snapshot 这种 2-8KB 的规则设 alwaysApply，
# 每次对话都挂上等于全仓库上下文恒定多 7K tokens，挤占有效信息密度。
RULES=(
  "ai-model-visibility|globs:auto|AI 模型可见性 —— UI 必须展示当前调用的模型名"
  "app-identity|globs:auto|应用身份隔离 —— Controller 硬编码 appKey，8 个应用标识"
  "bridge-ops|globs:auto|Page Agent Bridge 操作规范：鼠标轨迹 + spa-navigate + description 必填"
  "cds-first-verification|description: 改完可执行代码却发现本地缺 dotnet/node/cargo 时阅读|CDS 优先验证：本地无 SDK ≠ 无法验证，禁止把验证负担转嫁给用户"
  "codebase-snapshot|description: 查询项目功能状态/MongoDB 集合/已废弃概念/架构模式时阅读|代码库快照：架构模式、功能注册表、115 个 MongoDB 集合、已废弃概念"
  "data-audit|globs:auto|数据关系审计：新增实体引用时必须审计所有消费端点"
  "doc-types|globs:auto|doc/ 下文档 7 种类型前缀（spec/design/plan/rule/guide/report/debt）"
  "e2e-verification|description: 功能开发完成后准备验收时阅读|端到端验收：API 200 不等于功能正常，必须打开真实页面逐项核查"
  "enum-ripple-audit|globs:auto|枚举/常量扩展涟漪审计：全栈 6 层同步"
  "frontend-architecture|globs:auto|前端架构：无业务状态 + SSOT + 注册表 + 统一 Loader + 默认可编辑"
  "frontend-modal|globs:auto|模态框 3 硬约束：inline style 高度 + createPortal + min-h:0"
  "gesture-unification|description: 实现 2D 画布平移/缩放时阅读（ReactFlow / 自定义 canvas / Konva）|画布手势统一原则"
  "guided-exploration|globs:auto|陌生页面 3 秒内知道做什么：空状态引导 + 首次使用引导 + 操作提示"
  "llm-gateway|globs:auto|LLM Gateway 统一调用规则 + LlmRequestContext.UserId 必填 + 流式场景陷阱"
  "marketplace|description: 发布配置到海鲜市场时阅读（CONFIG_TYPE_REGISTRY + IForkable）|海鲜市场扩展指南"
  "navigation-registry|globs:auto|新 Agent 默认注册百宝箱 + 带 wip:true + 交付必须声明位置和点击路径"
  "no-auto-index|globs:auto|禁止应用启动时自动创建 MongoDB 索引"
  "no-localstorage|globs:auto|禁止使用 localStorage，统一 sessionStorage"
  "no-rootless-tree|description: 设计新功能/定义 AI 能力/涌现探索时阅读，防止声明系统不具备的能力|无根之木禁令 + 借用法则"
  "quickstart-zero-friction|description: 编写 init/quickstart/setup 脚本或 Dockerfile 时阅读|快速启动零摩擦原则：依赖自动检查 + 交互式安装"
  "server-authority|globs:auto|服务器权威性：CancellationToken.None + Run/Worker + SSE 心跳"
  "snapshot-fallback|globs:auto|快照反规范化兜底：Fallback 字段必须与 Snapshot 完全对齐"
  "zero-friction-input|globs:auto|输入零摩擦：能上传不让用户手输，不确定就两个都给"
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

  # 去掉源文件已有的 YAML frontmatter（源规则用 paths 声明作用域）
  body="$(awk 'BEGIN{skip=0} NR==1 && $0=="---" {skip=1; next} skip==1 && $0=="---" {skip=0; next} skip==0 {print}' "$src_file")"

  # globs:auto —— 作用域从源规则的 paths frontmatter 派生，不在本脚本里另存一份。
  if [ "$frontmatter" = "globs:auto" ]; then
    derived="$(awk '
      NR==1 && $0=="---" { infm=1; next }
      infm && $0=="---"  { exit }
      infm && /^[[:space:]]*-[[:space:]]*"/ {
        line=$0; sub(/^[^"]*"/, "", line); sub(/".*$/, "", line)
        out = (out=="" ? line : out "," line)
      }
      END { print out }
    ' "$src_file")"
    if [ -z "$derived" ]; then
      echo "[ERROR] $name 标了 globs:auto，但 $src_file 没有 paths frontmatter" >&2
      echo "        要么给源规则加 paths，要么在本表改成 description: 形式" >&2
      exit 1
    fi
    frontmatter="globs: $derived"
  fi

  # description 字段是 Cursor 判断"何时拉取规则"的依据。
  # - globs / alwaysApply 规则：追加一条 description 作为内容摘要
  # - description-only 规则：frontmatter 里本身就是"何时加载"的触发语，保留即可
  if [[ "$frontmatter" == description:* ]]; then
    final_frontmatter="$frontmatter"
  else
    final_frontmatter=$(printf '%s\ndescription: %s' "$frontmatter" "$description")
  fi

  {
    echo "---"
    printf '%s\n' "$final_frontmatter"
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

# 索引文件（唯一 alwaysApply，刻意保持精简）
# 目的：告诉 AI 哪里找完整规则 + 永不再提的废弃概念
# 其余规则全部走 glob / description 按需加载
cat > "$DST/_index.mdc" <<EOF
---
alwaysApply: true
description: Cursor 规则入口 —— 事实源在 .claude/rules/，按需加载
---

<!-- scripts/sync-cursor-rules.sh 自动生成，勿直接编辑 -->

# PRD Agent 规则入口

事实源：\`.claude/rules/*.md\` + 项目根 \`CLAUDE.md\`
同步方式：\`bash scripts/sync-cursor-rules.sh\`（Cursor 侧只读）
完整索引：直接列 \`.claude/rules/\`，每条开头两行导读说明它管什么、什么时候撞上

## 禁止再引用的废弃概念

Guide mode→Prompt Stages · Provider→Platform · ImageMaster→VisualAgent ·
直接 SSE→Run/Worker + afterSeq · IEEE 830-1998→ISO/IEC/IEEE 29148:2018 ·
SmartModelScheduler→ILlmGateway · localStorage→sessionStorage · npm/yarn→pnpm
EOF

echo ""
echo "[OK] 生成 $GENERATED 条规则到 $DST"
if [ "$MISSING" -gt 0 ]; then
  echo "[WARN] $MISSING 条规则源文件缺失"
  exit 2
fi
