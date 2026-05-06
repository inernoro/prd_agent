#!/usr/bin/env bash
# scripts/release-prepare.sh
#
# 一键备好"待发版"的 CHANGELOG.md：
#   1. 跑 scripts/assemble-changelog.sh 合并 changelogs/ 碎片
#   2. 把 ## [未发布] 改名为 ## [<version>] - <date>
#   3. 在该版本块顶部插入 "用户更新项" bullet 列表（来自 --notes-file）
#   4. 在最上面追加新的 ## [未发布]，给下个版本预留
#   5. git add CHANGELOG.md + changelogs/，commit
#
# 本脚本不动版本号文件、不打 tag、不 push —— 那些由 ./quick.sh release <version> 完成。
# 设计意图：让 release 全程"备料 + 检查 + 收尾"清楚分两步，备料完后人能 review 一眼再收尾。
#
# 用法：
#   bash scripts/release-prepare.sh 1.9.0 --notes-file /tmp/release-notes.md
#   bash scripts/release-prepare.sh 1.9.0 --notes-file /tmp/release-notes.md --dry-run
#   bash scripts/release-prepare.sh 1.9.0 --notes-stdin     # 从 stdin 读 notes
#   bash scripts/release-prepare.sh 1.9.0 --no-notes        # 跳过 notes（不推荐，弹窗会无内容）
#
# notes 文件格式：每行一个 bullet（不带 "- " 前缀），脚本会自动包成：
#   > **用户更新项**
#   > - 第一条
#   > - 第二条

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHANGELOG="$SCRIPT_DIR/CHANGELOG.md"
ASSEMBLER="$SCRIPT_DIR/scripts/assemble-changelog.sh"

# ── 颜色输出 ─────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log_info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
log_success() { echo -e "${GREEN}[OK]${NC} $*"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error()   { echo -e "${RED}[ERR]${NC} $*" >&2; }

# ── 参数解析 ────────────────────────────────────────────────────
VERSION=""
NOTES_FILE=""
NOTES_FROM_STDIN=false
NO_NOTES=false
DRY_RUN=false
SKIP_ASSEMBLE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --notes-file)  NOTES_FILE="$2"; shift 2 ;;
    --notes-stdin) NOTES_FROM_STDIN=true; shift ;;
    --no-notes)    NO_NOTES=true; shift ;;
    --dry-run)     DRY_RUN=true; shift ;;
    --skip-assemble) SKIP_ASSEMBLE=true; shift ;;
    -h|--help)
      sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*)
      log_error "未知选项：$1"
      exit 1
      ;;
    *)
      if [[ -z "$VERSION" ]]; then
        VERSION="$1"
        shift
      else
        log_error "多余参数：$1"
        exit 1
      fi
      ;;
  esac
done

if [[ -z "$VERSION" ]]; then
  log_error "用法：bash scripts/release-prepare.sh <version> [--notes-file <path> | --notes-stdin | --no-notes] [--dry-run]"
  exit 1
fi

# 规范化版本号（剥掉 v 前缀）
if [[ "$VERSION" == v* ]]; then VERSION="${VERSION:1}"; fi
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([\-+][0-9A-Za-z\.\-]+)?$ ]]; then
  log_error "版本号格式不对：'$VERSION'（应为 1.2.3 或 v1.2.3）"
  exit 1
fi
TAG_NAME="v$VERSION"
TODAY="$(date +%Y-%m-%d)"

cd "$SCRIPT_DIR"

# ── 前置校验 ────────────────────────────────────────────────────
if [[ ! -f "$CHANGELOG" ]]; then
  log_error "找不到 $CHANGELOG"
  exit 1
fi

if ! grep -q '^## \[未发布\]' "$CHANGELOG"; then
  log_error "$CHANGELOG 里找不到 '## [未发布]' 标记，无法定位插入点"
  exit 1
fi

if grep -q "^## \[$VERSION\]" "$CHANGELOG"; then
  log_error "$CHANGELOG 里已存在 '## [$VERSION]'，疑似重复发版"
  exit 1
fi

if ! $DRY_RUN && git rev-parse "$TAG_NAME" >/dev/null 2>&1; then
  log_error "git tag '$TAG_NAME' 已存在，疑似重复发版"
  exit 1
fi

if ! $DRY_RUN && ! git diff --quiet HEAD 2>/dev/null; then
  log_error "工作区有未提交的非 changelog 改动，本脚本只会暂存 CHANGELOG.md 和 changelogs/，"
  log_error "你的其他改动会留在工作区，紧接的 ./quick.sh release 会因为 'git diff --quiet HEAD' 失败而 abort。"
  log_error "请先 stash / commit / 丢弃这些改动再来："
  git status --short
  exit 1
fi

# 至少要有一种 notes 来源
if [[ -z "$NOTES_FILE" ]] && ! $NOTES_FROM_STDIN && ! $NO_NOTES; then
  log_error "请用 --notes-file <path> / --notes-stdin / --no-notes 之一指定 release notes 来源"
  exit 1
fi

# ── 读取 notes ──────────────────────────────────────────────────
NOTES_TEXT=""
if $NO_NOTES; then
  log_warn "选择了 --no-notes，桌面端更新弹窗的本版块将无内容（不推荐）"
elif $NOTES_FROM_STDIN; then
  log_info "从 stdin 读取 release notes（按 Ctrl-D 结束）..."
  NOTES_TEXT="$(cat)"
elif [[ -n "$NOTES_FILE" ]]; then
  if [[ ! -f "$NOTES_FILE" ]]; then
    log_error "notes 文件不存在：$NOTES_FILE"
    exit 1
  fi
  NOTES_TEXT="$(cat "$NOTES_FILE")"
fi

# 把 notes 包成 "> - …" 形式；忽略空行；已经带 "- " / "* " / "> " 前缀的剥掉再统一加
build_notes_block() {
  local raw="$1"
  if [[ -z "$raw" ]]; then return 0; fi
  echo "> **用户更新项**"
  while IFS= read -r line; do
    # 去掉前后空白
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" ]] && continue
    # 跳过用户自己写的 "> **用户更新项**" 头
    if [[ "$line" =~ ^\>?\ ?\*\*用户更新项\*\* ]]; then continue; fi
    # 剥掉已有的列表前缀（用 case 避免 glob 把 "* " 解析成通配）
    case "$line" in
      "> - "*) line="${line:4}" ;;
      "> * "*) line="${line:4}" ;;
      "> "*)   line="${line:2}" ;;
      "- "*)   line="${line:2}" ;;
      "* "*)   line="${line:2}" ;;
    esac
    echo "> - $line"
  done <<< "$raw"
}

NOTES_BLOCK="$(build_notes_block "$NOTES_TEXT")"

# ── 执行 ────────────────────────────────────────────────────────
if $DRY_RUN; then
  log_info "[dry-run] 跳过 assembler / 编辑 / commit。"
  if [[ -n "$NOTES_BLOCK" ]]; then
    echo
    echo "===== 将要插入到 ## [$VERSION] - $TODAY 顶部的内容 ====="
    echo "$NOTES_BLOCK"
    echo "==========================================================="
  fi
  exit 0
fi

# Step 1: 合并碎片（除非 --skip-assemble）
if $SKIP_ASSEMBLE; then
  log_info "[1/5] 跳过 assembler（--skip-assemble）"
else
  log_info "[1/5] 合并 changelogs/ 碎片..."
  bash "$ASSEMBLER"
fi

# Step 2-4: 重写 CHANGELOG.md
log_info "[2/5] 重写 CHANGELOG.md：[未发布] → [$VERSION] - $TODAY，并预留新 [未发布]"

python3 - "$CHANGELOG" "$VERSION" "$TODAY" "$NOTES_BLOCK" <<'PYEOF'
import sys, pathlib

path = pathlib.Path(sys.argv[1])
version = sys.argv[2]
today = sys.argv[3]
notes_block = sys.argv[4]

text = path.read_text(encoding='utf-8')
lines = text.split('\n')

# 找到第一个 "## [未发布]"
target = None
for i, line in enumerate(lines):
    if line.strip() == '## [未发布]':
        target = i
        break

if target is None:
    sys.stderr.write("找不到 '## [未发布]'\n")
    sys.exit(1)

# 把它改名成 "## [<version>] - <today>"
lines[target] = f'## [{version}] - {today}'

# 在该行之前插入新的 "## [未发布]" + 一行空行
prefix = ['## [未发布]', '']
# 如果上一行不是空行，再在 prefix 最前面补一行空行隔开（不是 append，避免空行加到 [未发布] 下面）
if target > 0 and lines[target - 1].strip() != '':
    prefix.insert(0, '')
lines = lines[:target] + prefix + lines[target:]

# 重新定位被改名行（往后挪了 len(prefix) 行）
target += len(prefix)

# 在改名行后插入空行 + notes block（结尾依靠原文件中的空行隔开 ### 日块）
insert = []
if notes_block:
    insert.append('')
    insert.extend(notes_block.split('\n'))

lines = lines[:target + 1] + insert + lines[target + 1:]

path.write_text('\n'.join(lines), encoding='utf-8')
print(f"[OK] CHANGELOG.md 已就位：## [{version}] - {today}")
PYEOF

# Step 5: commit（前置 dirty check 已保证工作区只剩 CHANGELOG.md / changelogs/ 这两处由本脚本产生的改动）
log_info "[3/5] 暂存改动..."
git add CHANGELOG.md
# changelogs/ 目录下被 assembler git rm 过的需要一并 add
git add changelogs/ 2>/dev/null || true

if git diff --cached --quiet; then
  log_warn "[4/5] 没有暂存改动，跳过 commit"
else
  log_info "[4/5] 提交 release 备料 commit..."
  git commit -m "docs(release): 备料 v$VERSION CHANGELOG"
fi

log_success "[5/5] CHANGELOG 已就位：## [$VERSION] - $TODAY"
echo
log_info "请 review 一下："
log_info "  git log -1 --stat"
log_info "  head -40 CHANGELOG.md"
echo
log_info "确认无误后跑下面这条完成 tag + push："
log_info "  ./quick.sh release $VERSION"
