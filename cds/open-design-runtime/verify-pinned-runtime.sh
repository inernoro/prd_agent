#!/usr/bin/env bash
# 校验「运行时源码里钉住的那枚镜像」真的满足「同一份源码里那条能力探针」的全部要求。
#
# 为什么存在：销钉与构建描述曾经各改各的——构建描述换成了 codex，销钉还指着装 opencode
# 的旧镜像，于是会话在每个节点都起不来，而当时的守卫只断言销钉「长得像一个摘要」，照样全绿。
#
# 判据只有一份：镜像、版本、资源目录与资源文件清单全部从运行时源码解析，不在本脚本里另写
# 一份清单。解析不出来一律判红（退出码 3），绝不静默跳过——一个不会红的守卫比没有守卫更糟。
set -euo pipefail

SRC="${1:-cds/src/services/agent-workspace-session-runtime.ts}"
[ -f "$SRC" ] || { echo "找不到运行时源码：$SRC" >&2; exit 3; }

image=$(sed -n "s/^export const OPEN_DESIGN_IMAGE = '\([^']*\)'.*/\1/p" "$SRC" | head -1)
version=$(sed -n "s/^export const OPEN_DESIGN_CODEX_VERSION = '\([^']*\)'.*/\1/p" "$SRC" | head -1)
proto=$(sed -n "s/^const OPEN_DESIGN_WEB_PROTOTYPE_SOURCE = '\([^']*\)'.*/\1/p" "$SRC" | head -1)
mapfile -t files < <(sed -n 's/.*test -f \${OPEN_DESIGN_WEB_PROTOTYPE_SOURCE}\/\([A-Za-z0-9._/-]*\).*/\1/p' "$SRC" | sort -u)

[ -n "$image" ]   || { echo "无法从源码解析 OPEN_DESIGN_IMAGE" >&2; exit 3; }
[ -n "$version" ] || { echo "无法从源码解析 OPEN_DESIGN_CODEX_VERSION" >&2; exit 3; }
[ -n "$proto" ]   || { echo "无法从源码解析 OPEN_DESIGN_WEB_PROTOTYPE_SOURCE" >&2; exit 3; }
[ "${#files[@]}" -ge 4 ] || {
  echo "只解析到 ${#files[@]} 个资源文件，探针要求至少 4 个；解析规则与源码已漂移" >&2; exit 3; }

# 环境不可用必须与「镜像不合格」分开：都返回 1 的话，读者无法判断是守卫发现了问题
# 还是守卫自己没跑起来。环境类问题一律 3。
docker info >/dev/null 2>&1 || { echo "Docker 守护进程不可用，本次校验未执行（不是镜像不合格）" >&2; exit 3; }

echo "镜像：$image"
echo "要求的 codex 版本：$version"
echo "要求的资源文件（${#files[@]} 个，解析自源码）：${files[*]}"

probe="test \"\$(codex --version)\" = \"codex-cli ${version}\""
for f in "${files[@]}"; do probe="${probe} && test -f ${proto}/${f}"; done

docker pull "$image" >/dev/null

# 与运行时能力探针同样的隔离条件：只读、无网络、丢能力、限资源。
if docker run --rm --pull never --read-only --network none \
    --security-opt no-new-privileges:true --cap-drop ALL \
    --pids-limit 64 --memory 128m --cpus 0.25 \
    --entrypoint /bin/sh "$image" -lc "$probe"; then
  echo "通过：钉住的镜像满足能力探针的全部要求"
else
  rc=$?
  echo "失败：钉住的镜像不满足能力探针（退出码 ${rc}）。会话将在每个节点被判定为不可用。" >&2
  echo "多半是换了构建描述却没换销钉——重建镜像后把 OPEN_DESIGN_IMAGE 换成新摘要。" >&2
  exit 1
fi
