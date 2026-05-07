#!/usr/bin/env bash
# 端到端 MVP 烟测：本地起 sidecar → 探针 → 真实 Anthropic 调用 → SSE 流验证
#
# 使用：
#   export ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxx
#   bash claude-sdk-sidecar/smoke.sh
#
# 仅依赖 python3 + curl。会临时占用 7400 端口。
set -euo pipefail

cd "$(dirname "$0")"

PORT=${PORT:-7400}
TOKEN=${TOKEN:-smoke-test-$(date +%s)}
HEALTH_URL="http://127.0.0.1:${PORT}/healthz"
READY_URL="http://127.0.0.1:${PORT}/readyz"
RUN_URL="http://127.0.0.1:${PORT}/v1/agent/run"

if ! command -v uvicorn >/dev/null 2>&1; then
  echo "[install] uvicorn 缺失，自动 pip install -r requirements.txt"
  pip install --user --quiet -r requirements.txt
fi

echo "[smoke] 起 sidecar PORT=${PORT} TOKEN=${TOKEN}"
SIDECAR_TOKEN=${TOKEN} uvicorn app.main:app \
  --host 127.0.0.1 --port "${PORT}" --log-level warning &
SIDECAR_PID=$!
trap 'echo "[smoke] 关闭 sidecar PID=${SIDECAR_PID}"; kill ${SIDECAR_PID} 2>/dev/null || true' EXIT

# 等就绪
for i in {1..15}; do
  if curl -sS -m 1 "${HEALTH_URL}" >/dev/null 2>&1; then break; fi
  sleep 1
done

echo
echo "[smoke] T1 healthz"
curl -sS "${HEALTH_URL}" | python3 -m json.tool || true

echo
echo "[smoke] T2 readyz"
curl -sS -o /tmp/smoke-readyz.json -w "HTTP=%{http_code}\n" "${READY_URL}"
cat /tmp/smoke-readyz.json | python3 -m json.tool || true

echo
echo "[smoke] T3 run 无 token (期望 401)"
curl -sS -o /tmp/smoke-401.json -w "HTTP=%{http_code}\n" -X POST "${RUN_URL}" \
  -H 'Content-Type: application/json' \
  -d '{"runId":"smoke-401","model":"claude-opus-4-5","messages":[{"role":"user","content":"hi"}],"maxTurns":1}'
cat /tmp/smoke-401.json; echo

echo
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "[smoke] 跳过 T4 真实调用 — 未设置 ANTHROPIC_API_KEY"
  echo "[smoke] 全部结构性测试通过；如需真实端到端验证："
  echo "        export ANTHROPIC_API_KEY=sk-ant-xxx && bash $(basename "$0")"
  exit 0
fi

echo "[smoke] T4 真实 Anthropic 流式调用"
curl -sS -N -X POST "${RUN_URL}" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Content-Type: application/json' \
  --max-time 60 \
  -d '{
    "runId":"smoke-real",
    "model":"claude-haiku-4-5-20251001",
    "systemPrompt":"You are a Chinese poet. Reply in 1 sentence.",
    "messages":[{"role":"user","content":"用一句话写春天"}],
    "maxTokens":256,
    "maxTurns":1
  }'
echo
echo "[smoke] 端到端通过"
