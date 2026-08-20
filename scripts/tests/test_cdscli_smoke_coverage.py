#!/usr/bin/env python3
"""冒烟覆盖不全时不许被上层当成成功。

这条链路上出过三次同一个假绿：L3 因为缺凭据没跑，而结论写着「全绿」。
前两次我改的是「把 L3 留在 layers 里」和「note 里点名缺口」——都没解决根本，
因为调用方 cmd_deploy 只看退出码，summary 里的 coverageComplete 和 note 它读不到。
判据必须是机器读得到的东西，所以钉的是退出码。
"""
import ast
import pathlib
import sys

CLI = pathlib.Path(__file__).resolve().parents[2] / ".claude" / "skills" / "cds" / "cli" / "cdscli.py"
SOURCE = CLI.read_text(encoding="utf-8")
TREE = ast.parse(SOURCE)


def function_source(name: str) -> str:
    for node in ast.walk(TREE):
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return ast.get_source_segment(SOURCE, node) or ""
    raise AssertionError(f"找不到函数 {name}，这条守卫的前提已变")


def test_smoke_覆盖不全时以独立非零码退出() -> None:
    src = function_source("cmd_smoke")
    assert "coverage_complete" in src, "cmd_smoke 不再计算覆盖完整性了？"
    tail = src[src.index("if coverage_complete:"):]
    assert "code=3" in tail, (
        "覆盖不全必须用独立退出码 3——调用方要能分出「测过了都过」和「有层压根没测」")
    assert "ok(summary, note=f\"已验证" not in tail, (
        "覆盖不全时不许再走 ok()，那是退出码 0，上层会当成功")


def test_deploy_不把覆盖不全说成全绿() -> None:
    src = function_source("cmd_deploy")
    assert "e.code == 3" in src, (
        "cmd_deploy 必须单独认 3，否则要么误判部署失败、要么继续说「全绿」")
    before_green = src[:src.index("deploy 流水线全绿")]
    assert "if smoke_gaps:" in before_green, (
        "说「全绿」之前必须先把有缺口的情况分流出去")


def main() -> int:
    failures = []
    for name, fn in sorted(globals().items()):
        if not name.startswith("test_") or not callable(fn):
            continue
        try:
            fn()
            print(f"  [ok] {name}")
        except AssertionError as exc:
            failures.append(f"{name}: {exc}")
            print(f"  [FAIL] {name}: {exc}")
    if failures:
        print(f"\n{len(failures)} 条断言失败")
        return 1
    print("cdscli 冒烟覆盖守卫全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
