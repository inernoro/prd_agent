# CDS 宿主机环境变量 — 在 CDS 服务器上执行或加入 ~/.bashrc / /etc/environment
# 复制此文件后填入真实值，然后 source 它再启动 CDS

# ── 腾讯云 COS ──
export TENCENT_COS_BUCKET="<your-bucket>"
export TENCENT_COS_REGION="<your-region>"
export TENCENT_COS_SECRET_ID="<your-secret-id>"
export TENCENT_COS_SECRET_KEY="<your-secret-key>"
export TENCENT_COS_PUBLIC_BASE_URL="<your-cdn-url>"
export TENCENT_COS_PREFIX="data"

# ── 认证 ──
export JWT_SECRET="<your-jwt-secret>"
export AI_ACCESS_KEY="<your-ai-access-key>"

# ── 资产 ──
export ASSETS_PROVIDER="tencentCos"
