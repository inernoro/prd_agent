#!/usr/bin/env python3
"""守卫：仓库里可执行的脚本不许写死某一台机器的 checkout 绝对路径。

为什么值得一条守卫：这类缺陷不是「换台机器慢一点」，是**换个 checkout 就在加载模块之前
挂掉**——Node 报 ERR_MODULE_NOT_FOUND、Python 报 FileNotFoundError，脚本里所有的环境
自检、所有的友好提示，一行都来不及跑。而写脚本的人在自己那台机器上跑得好好的，
本地怎么测都是绿的（第 75 轮 review：一条「真人路径视觉验收」脚本在别的 checkout 里
根本起不来）。

判据是**结构不是措辞**：扫的是「以 / 开头、并且包含本仓库目录名的字符串字面量」，
不是某一个具体路径。有人把 /home/user/prd_agent 换成 /workspace/prd_agent 照样红。

不扫的：注释与文档里可以出现这些路径（讲的就是它）；系统级安装位置
（/opt、/usr、/tmp 这些不随 checkout 走的）不在此列。
"""
import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parents[2]

# 扫哪些目录：仓库里「会被直接 node/python 跑起来」的脚本。
SCAN_DIRS = ["e2e", "scripts", ".claude/skills"]
SCAN_SUFFIXES = {".mjs", ".js", ".cjs", ".py", ".sh"}

# 仓库目录名可能随 checkout 改（prd_agent / prd-agent / 别人 fork 的名字），
# 所以判据不认某个固定名字，认「绝对路径里出现了本仓库根的目录名」这个结构。
REPO_DIR_NAME = REPO.name
ABS_LITERAL = re.compile(r"""['"](/[^'"\s]*/%s/[^'"]*)['"]""" % re.escape(REPO_DIR_NAME))

# 注释行不算：讲这条规矩本身要引用路径。
COMMENT_PREFIXES = ("#", "//", "*", "/*")


def offending_lines(path: pathlib.Path):
    try:
        text = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return []
    hits = []
    for lineno, line in enumerate(text.splitlines(), 1):
        if line.lstrip().startswith(COMMENT_PREFIXES):
            continue
        for match in ABS_LITERAL.finditer(line):
            hits.append((lineno, match.group(1)))
    return hits


def main() -> int:
    failures = []
    for rel in SCAN_DIRS:
        root = REPO / rel
        if not root.exists():
            continue
        for path in root.rglob("*"):
            if not path.is_file() or path.suffix not in SCAN_SUFFIXES:
                continue
            if "node_modules" in path.parts:
                continue
            for lineno, literal in offending_lines(path):
                failures.append(f"{path.relative_to(REPO)}:{lineno} 写死了 checkout 路径 {literal}")

    if failures:
        print("发现写死的 checkout 绝对路径（换个 checkout 会在加载阶段直接挂）：", file=sys.stderr)
        for item in failures:
            print(f"  {item}", file=sys.stderr)
        print(
            "\n改法：Node 用 new URL('../相对路径', import.meta.url)；"
            "Python 用 pathlib.Path(__file__).resolve().parents[N]；"
            "确实要指到仓库外的安装位置就走环境变量，并在找不到时明确报错。",
            file=sys.stderr,
        )
        return 1

    print(f"通过：{', '.join(SCAN_DIRS)} 下没有写死的 checkout 绝对路径")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
