#!/usr/bin/env bash
# 海鲜市场技能开放接口 · CDS 部署后自测脚本
# 覆盖：官方技能下载 + 列表虚拟注入 + Fork 特判
#
# 需要公开接口验证 —— 不需要 AgentApiKey 的都能直接跑
# 需要 Key 的那几条走 JWT cookie 或 ApiKey，留 MANUAL 标签给人工跑
set -u
BASE="${1:-https://claude-skill-platform-open-api-gkafy.miduo.org}"
PASS=0
FAIL=0

pass() { echo "✅ PASS · $1"; PASS=$((PASS+1)); }
fail() { echo "❌ FAIL · $1  ($2)"; FAIL=$((FAIL+1)); }

echo "========================================"
echo "  自测目标：$BASE"
echo "========================================"
echo ""

# ─────── T1: 预览域名可达 ───────
echo "─── T1: Preview 域名可达性 ───"
CODE=$(curl -sS -o /dev/null -m 10 -w "%{http_code}" "$BASE/" 2>/dev/null)
if [ "$CODE" = "200" ] || [ "$CODE" = "304" ]; then
  pass "GET / → HTTP $CODE"
else
  fail "GET / → HTTP $CODE" "预期 200/304"
fi

# ─────── T2: 官方技能包匿名下载 ───────
echo ""
echo "─── T2: GET /api/official-skills/findmapskills/download（匿名可访问）───"
OUT="/tmp/findmapskills-smoke.zip"
CODE=$(curl -sS -o "$OUT" -m 30 -w "%{http_code}" \
  -H "X-Client-Base-Url: $BASE" \
  "$BASE/api/official-skills/findmapskills/download" 2>/dev/null)
if [ "$CODE" = "200" ]; then
  SIZE=$(wc -c < "$OUT" | tr -d ' ')
  pass "下载成功 · HTTP 200 · ${SIZE} bytes"

  # ─────── T3: zip 格式 + 内容完整性 ───────
  if file "$OUT" | grep -q "Zip archive"; then
    pass "文件格式 = zip"
  else
    fail "文件格式异常" "$(file "$OUT")"
  fi

  # ─────── T4: zip 内 SKILL.md 含版本号 ───────
  if unzip -p "$OUT" findmapskills/SKILL.md 2>/dev/null | grep -q '\*\*版本\*\*：1.0.0'; then
    pass "SKILL.md 含正确版本号 v1.0.0"
  else
    fail "SKILL.md 版本号缺失" "未找到 '**版本**：1.0.0'"
  fi

  # ─────── T5: zip 内 SKILL.md 含 BASE_URL 占位符已替换 ───────
  if unzip -p "$OUT" findmapskills/SKILL.md 2>/dev/null | grep -q "$BASE"; then
    pass "SKILL.md BASE_URL 已正确替换为 $BASE"
  else
    fail "SKILL.md BASE_URL 替换失败" "仍有 {{BASE_URL}} 占位符未替换"
  fi

  # ─────── T6: zip 内 README 存在 ───────
  if unzip -l "$OUT" 2>/dev/null | grep -q "findmapskills/README.md"; then
    pass "zip 包含 README.md"
  else
    fail "zip 缺少 README.md" ""
  fi
else
  fail "下载端点 HTTP $CODE" "预期 200"
fi

# ─────── T7: 列表端点（未登录应 401）———
echo ""
echo "─── T7: GET /api/marketplace/skills（要 JWT）应返回 401 ───"
CODE=$(curl -sS -o /dev/null -m 10 -w "%{http_code}" "$BASE/api/marketplace/skills" 2>/dev/null)
if [ "$CODE" = "401" ]; then
  pass "匿名访问 /api/marketplace/skills → HTTP 401（鉴权生效）"
else
  fail "匿名访问应返回 401 但得到 HTTP $CODE" ""
fi

# ─────── T8: OpenAPI 列表端点（未带 Key 应 401）———
echo ""
echo "─── T8: GET /api/open/marketplace/skills（要 ApiKey）应返回 401 ───"
CODE=$(curl -sS -o /dev/null -m 10 -w "%{http_code}" "$BASE/api/open/marketplace/skills" 2>/dev/null)
if [ "$CODE" = "401" ]; then
  pass "匿名访问 /api/open/marketplace/skills → HTTP 401"
else
  fail "匿名访问应返回 401 但得到 HTTP $CODE" ""
fi

# ─────── Summary ───────
echo ""
echo "========================================"
echo "  结果：$PASS passed · $FAIL failed"
echo "========================================"

echo ""
echo "⚠️  下列测试需要真人介入（需要 AgentApiKey 或 JWT cookie）："
echo ""
echo "  MANUAL-1 · 列表虚拟注入官方条目（AgentApiKey 鉴权，需先在 UI 建 Key）："
echo "    KEY='sk-ak-xxxx'"
echo "    curl -sS -H \"Authorization: Bearer \$KEY\" \\"
echo "      \"$BASE/api/open/marketplace/skills?limit=5\" | jq '.data.items[0] | {id,ownerUserId,title}'"
echo "    期望：items[0].id == 'official-findmapskills', ownerUserId == 'official'"
echo ""
echo "  MANUAL-2 · Fork 官方条目应返回官方下载 URL："
echo "    curl -sS -X POST -H \"Authorization: Bearer \$KEY\" \\"
echo "      -H \"Content-Type: application/json\" -d '{}' \\"
echo "      \"$BASE/api/open/marketplace/skills/official-findmapskills/fork\" \\"
echo "      | jq '.data.downloadUrl'"
echo "    期望：以 $BASE/api/official-skills/findmapskills/download 结尾"
echo ""
echo "  MANUAL-3 · 浏览器端端到端验收："
echo "    1. 打开 $BASE/marketplace"
echo "    2. 技能 tab 首位应是 🛡️ 官方 findmapskills 卡片"
echo "    3. 点右上角「接入 AI」→「智能体接入」→ 创建 Key"
echo "    4. 明文态点「复制给智能体使用」粘贴到文本编辑器"
echo "    5. 按指令 curl 下载 findmapskills.zip → unzip 后看到 SKILL.md v1.0.0"

exit $FAIL
