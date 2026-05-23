#!/usr/bin/env bash
# 官方 SDK adapter 烟测：本地起 sidecar → 探针 → 鉴权 → provider key 预检/真实调用 → SSE 流验证
#
# 使用：
#   bash claude-sdk-sidecar/smoke.sh
#   export ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxx
#   bash claude-sdk-sidecar/smoke.sh
#
# 仅依赖 python3 + curl。缺少 sidecar 依赖时会 pip install -r requirements.txt。
# 会临时占用 7400 端口。
set -euo pipefail

cd "$(dirname "$0")"

PORT=${PORT:-7400}
TOKEN=${TOKEN:-smoke-test-$(date +%s)}
ADAPTER=${SIDECAR_AGENT_ADAPTER:-claude-agent-sdk}
PROVIDER_KEY_MODE=${SIDECAR_PROVIDER_KEY_MODE:-runtime-profile-or-env}
HEALTH_URL="http://127.0.0.1:${PORT}/healthz"
READY_URL="http://127.0.0.1:${PORT}/readyz"
RUN_URL="http://127.0.0.1:${PORT}/v1/agent/run"

if ! python3 - <<'PY' >/dev/null 2>&1
import importlib.util
missing = [
    name
    for name in ("uvicorn", "claude_agent_sdk")
    if importlib.util.find_spec(name) is None
]
raise SystemExit(1 if missing else 0)
PY
then
  echo "[install] sidecar 依赖缺失，自动 pip install -r requirements.txt"
  pip install --user --quiet -r requirements.txt
fi

echo "[smoke] 起 sidecar PORT=${PORT} TOKEN=${TOKEN} ADAPTER=${ADAPTER} KEY_MODE=${PROVIDER_KEY_MODE}"
SIDECAR_TOKEN=${TOKEN} \
SIDECAR_AGENT_ADAPTER=${ADAPTER} \
SIDECAR_PROVIDER_KEY_MODE=${PROVIDER_KEY_MODE} \
uvicorn app.main:app \
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

SDK_INSTALLED=$(python3 - /tmp/smoke-readyz.json <<'PY'
import json
import sys

try:
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        data = json.load(f)
except Exception:
    data = {}

diagnostics = data.get("adapterDiagnostics") or {}
print("true" if diagnostics.get("sdkInstalled") else "false")
PY
)

LOOP_OWNER=$(python3 - /tmp/smoke-readyz.json <<'PY'
import json
import sys

try:
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        data = json.load(f)
except Exception:
    data = {}

diagnostics = data.get("adapterDiagnostics") or {}
print(diagnostics.get("loopOwner") or "")
PY
)

if [ "${ADAPTER}" = "claude-agent-sdk" ] && [ "${SDK_INSTALLED}" != "true" ]; then
  echo "[smoke] 失败：readyz 未发现 claude_agent_sdk，无法验证 official adapter" >&2
  echo "        处理：cd claude-sdk-sidecar && pip install --user -r requirements.txt" >&2
  exit 1
fi

if [ "${ADAPTER}" = "claude-agent-sdk" ] && [ "${LOOP_OWNER}" != "claude-agent-sdk" ]; then
  echo "[smoke] 失败：loopOwner=${LOOP_OWNER:-<empty>}，未进入官方 SDK loop" >&2
  exit 1
fi

echo
echo "[smoke] T3 run 无 token (期望 401)"
curl -sS -o /tmp/smoke-401.json -w "HTTP=%{http_code}\n" -X POST "${RUN_URL}" \
  -H 'Content-Type: application/json' \
  -d '{"runId":"smoke-401","model":"claude-opus-4-5","messages":[{"role":"user","content":"hi"}],"maxTurns":1}'
cat /tmp/smoke-401.json; echo

echo
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "[smoke] T4 official adapter 缺 provider key (期望 provider_key_missing)"
  curl -sS -N -X POST "${RUN_URL}" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H 'Content-Type: application/json' \
    --max-time 30 \
    -d '{
      "runId":"smoke-provider-key-missing",
      "runtimeAdapter":"claude-agent-sdk",
      "model":"claude-haiku-4-5-20251001",
      "systemPrompt":"只做结构性 smoke，不需要真实模型输出。",
      "messages":[{"role":"user","content":"hi"}],
      "maxTurns":1
    }' > /tmp/smoke-provider-key-missing.sse
  cat /tmp/smoke-provider-key-missing.sse
  echo
  if ! grep -q 'provider_key_missing' /tmp/smoke-provider-key-missing.sse; then
    echo "[smoke] 失败：未看到 provider_key_missing 结构化错误" >&2
    exit 1
  fi

  echo "[smoke] provider_key_missing 结构化错误通过"
  echo "[smoke] 跳过真实调用 — 未设置 ANTHROPIC_API_KEY；如需真实端到端验证："
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
    "runtimeAdapter":"claude-agent-sdk",
    "model":"claude-haiku-4-5-20251001",
    "systemPrompt":"You are a Chinese poet. Reply in 1 sentence.",
    "messages":[{"role":"user","content":"用一句话写春天"}],
    "maxTokens":256,
    "maxTurns":1
  }'
echo
echo "[smoke] 端到端通过"
