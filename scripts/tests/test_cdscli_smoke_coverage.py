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


def test_deploy只输出一份结果() -> None:
    """内部调用不许自己打印结论。

    覆盖不全的退出码修好之后冒出的第二个问题：cmd_smoke 走的是 die()，它**先打印**
    一份 ok:false 再退出，cmd_deploy 接住 code=3 之后又打印一份 ok:true。
    机器读到两个 JSON 文档等于两个都不能信，人看到「失败」后面紧跟「成功」。
    出口只能有一个，所以内部调用必须走 _nested_call() 把 payload 收走。
    """
    src = function_source("cmd_deploy")
    smoke_call = src[src.index("cmd_smoke(ns)") - 400:src.index("cmd_smoke(ns)") + 600]
    assert "_nested_call()" in smoke_call, (
        "cmd_deploy 调 cmd_smoke 必须包在 _nested_call() 里，否则 smoke 会自己打印一份结果")
    assert "die(\"smoke 失败\", code=2" not in src, (
        "在 _nested_call() 作用域里调 die 只会被收走、不会打印，"
        "失败必须留到退出上下文之后再报")


def test_覆盖不全时deploy必须以非零码退出() -> None:
    """
    机器调用方看的是退出状态，不是 note 的措辞。

    这个假绿回潮过四次，每次都死在同一个地方：改了注释、改了 note、改了上层判断，
    唯独没动**真正被读的那个值**。所以断言直接钉退出码，不钉文案。
    """
    src = function_source("cmd_deploy")
    branch = src[src.index("if smoke_gaps:"):]
    branch = branch[:branch.index("return") + len("return")]
    assert "code=3" in branch, (
        "覆盖不全这条分支必须以非零码退出：ok() 默认退 0，"
        "于是「部署完成但关键一层没验」照样被上层当成通过")

    ok_src = function_source("ok")
    assert "code: int = 0" in ok_src, "ok() 要支持非零退出码，否则上面那条钉不住"
    assert "sys.exit(code)" in ok_src, "ok() 必须真的用这个码退出，不能收下参数却仍然退 0"


def test_die与ok在内部调用时不打印() -> None:
    for name in ("die", "ok"):
        src = function_source(name)
        assert "_SUPPRESS_EMIT" in src, (
            f"{name}() 必须认 _SUPPRESS_EMIT，否则内部调用照样往 stdout 写，"
            "上层再写一份就是两份互相矛盾的结果")
        head = src[:src.index("_HUMAN")]
        assert "_SUPPRESS_EMIT" in head, (
            f"{name}() 的抑制判断必须在打印之前，放在后面等于没放")


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
