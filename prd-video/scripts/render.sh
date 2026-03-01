#!/bin/bash
# 视频渲染脚本
# 用法: ./scripts/render.sh <run-id>

set -euo pipefail

RUN_ID="${1:?Usage: render.sh <run-id>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DATA_FILE="${PROJECT_DIR}/data/${RUN_ID}.json"
OUTPUT_FILE="${PROJECT_DIR}/out/${RUN_ID}.mp4"
SRT_FILE="${PROJECT_DIR}/out/${RUN_ID}.srt"

echo "=== Video Render Pipeline ==="
echo "Run ID:  ${RUN_ID}"
echo "Data:    ${DATA_FILE}"
echo "Output:  ${OUTPUT_FILE}"

# 检查数据文件
if [ ! -f "${DATA_FILE}" ]; then
    echo "ERROR: Data file not found: ${DATA_FILE}"
    exit 1
fi

# 确保输出目录存在
mkdir -p "${PROJECT_DIR}/out"

# 安装依赖（如果需要）
if [ ! -d "${PROJECT_DIR}/node_modules" ]; then
    echo "Installing dependencies..."
    cd "${PROJECT_DIR}" && npm install
fi

# 渲染视频
echo "Rendering video..."
cd "${PROJECT_DIR}"
npx remotion render TutorialVideo "${OUTPUT_FILE}" --props="${DATA_FILE}"

echo "Video rendered: ${OUTPUT_FILE}"

# 生成字幕
echo "Generating subtitles..."
python3 "${SCRIPT_DIR}/generate_srt.py" --data "${DATA_FILE}" --output "${SRT_FILE}"

echo "=== Pipeline Complete ==="
echo "MP4: ${OUTPUT_FILE}"
echo "SRT: ${SRT_FILE}"
