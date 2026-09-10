#!/usr/bin/env python3
"""cdscli monitor 的判据解析自检。

判据写成 `path:op:value` 一行文本，最容易在两个地方出错，而且都不会报错、
只会静默把判据变成另一条：

  1. 期望值自带冒号（`16:9`、时间、URL）——切多了会把它拦腰截断，
     于是判据从「等于 16:9」变成「等于 16」，永远不通过；
  2. exists / absent 不需要期望值——强制要求会让这两个运算根本没法用。

SSOT：.claude/rules/degradation-must-alarm.md
"""

from __future__ import annotations

import importlib.util
import pathlib
import sys

REPO = pathlib.Path(__file__).resolve().parents[2]
CLI = REPO / ".claude/skills/cds/cli/cdscli.py"


def load_cli():
    spec = importlib.util.spec_from_file_location("cdscli_under_test", CLI)
    if spec is None or spec.loader is None:
        raise SystemExit(f"cdscli monitor contract failed:\n- 加载不了 {CLI}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main() -> int:
    cli = load_cli()
    parse = cli._parse_assertion
    errors: list[str] = []

    def check(label: str, got, want) -> None:
        if got != want:
            errors.append(f"{label}: 得到 {got!r}，期望 {want!r}")

    check("基本三元组", parse("image.height:eq:1024"), {"path": "image.height", "op": "eq", "value": "1024"})
    # 只切两刀：多切会把 16:9 截成 16
    check("期望值带冒号", parse("meta.ratio:eq:16:9"), {"path": "meta.ratio", "op": "eq", "value": "16:9"})
    check("期望值是完整 URL", parse("data.url:eq:https://a.test/x"),
          {"path": "data.url", "op": "eq", "value": "https://a.test/x"})
    check("exists 不需要期望值", parse("image.url:exists"), {"path": "image.url", "op": "exists"})
    check("absent 不需要期望值", parse("error:absent"), {"path": "error", "op": "absent"})
    # 期望值是 0 不能被当成「没填」——「数量等于 0」正是最该写出来的判据
    check("期望值为 0", parse("errors:eq:0"), {"path": "errors", "op": "eq", "value": "0"})

    for bad, why in [("nothing", "缺运算"), (":eq:1", "缺路径"), ("a::1", "缺运算"), ("a:eq", "eq 缺期望值")]:
        try:
            parse(bad)
        except SystemExit:
            pass
        else:
            errors.append(f"{bad!r}（{why}）本该被拒，却解析通过了")

    if errors:
        print("cdscli monitor contract failed:")
        for e in errors:
            print(f"- {e}")
        return 1
    print("cdscli monitor contract passed: 判据解析 6 项正例、4 项反例均符合")
    return 0


if __name__ == "__main__":
    sys.exit(main())
