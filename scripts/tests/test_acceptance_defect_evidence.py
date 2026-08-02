#!/usr/bin/env python3
"""验收归档脚本的结构化缺陷证据守卫。

背景：`archive_report.py` 在生成交互式 HTML 时**本来就已经**把「缺陷清单」和
「根因链条」两张表解析过一次（重点卡靠它），但解析完就丢了 —— 上传给 CDS 的 payload
里只有标题/正文/verdict。服务端拿到的是渲染后的 HTML，重新解析成本高且脆，于是
「哪个模块反复出问题」这类跨报告统计**根本无从做起**。

本守卫钉死两件事：

  1. **提取判据够宽**（predicate-and-wiring-discipline 形状 1）：严重度大小写、
     markdown 星号、列序变化、表头缺「严重级」列都得吃得下。只认一种写法的提取器
     会静默返回空列表，而调用方看到空列表只会跳过上传，全链路无任何报错。

  2. **提取结果真的被上传**（形状 2）：`run_cds` 的 payload 里必须出现
     defectRows / rootCauseRows / defectCounts。提取函数写得再对，没人调用就是
     建了一半 —— 而这条接线删掉之后，上面第 1 组用例仍然全绿。

CI 通过 .github/workflows/ci.yml 的 `for t in scripts/tests/test_*.py` 自动执行；
被守文件 `.claude/skills/create-visual-test-to-kb/scripts/archive_report.py` 已登记进
该 job 的 path filter（形状 7：只改被守文件的 PR 也必须触发本守卫）。
"""
import importlib.util
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
TARGET = ROOT / ".claude/skills/create-visual-test-to-kb/scripts/archive_report.py"

failures = []


def check(condition, message):
    if not condition:
        failures.append(message)


def load_module():
    spec = importlib.util.spec_from_file_location("archive_report_under_test", TARGET)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def check_extraction(mod):
    extract = getattr(mod, "extract_defect_evidence", None)
    if extract is None:
        failures.append("archive_report.py 缺少 extract_defect_evidence —— 结构化证据无从产出")
        return

    # 标准形状：ID 在首列、严重级第二列（每日验收常用列序）
    standard = """## 缺陷清单

| 编号 | 严重级 | 页面/模块 | 现象 |
|---|---|---|---|
| D-01 | P0 | 视觉创作/编辑器 | 预览空白 |
| D-02 | p1 | 报告中心 | 缩略图错位 |

## 根因链条

| 目标要求 | 观察事实 | 系统原因 | 证据影响 | 结论 | 关闭动作 |
|---|---|---|---|---|---|
| 预览可见 | 空白 | 解析器未接线 | 图01 | 产品失败 | 补接线 |
"""
    out = extract(standard)
    check(len(out["defectRows"]) == 2, f"标准缺陷表应抽出 2 行，实际 {len(out['defectRows'])}")
    check(
        out["defectRows"][0].get("module") == "视觉创作/编辑器",
        f"未认出「页面/模块」列，实际 {out['defectRows'][0]!r}",
    )
    check(
        out["defectRows"][0].get("symptom") == "预览空白",
        f"未认出「现象」列，实际 {out['defectRows'][0]!r}",
    )
    # 严重度原文保留：归一化是消费端（CDS digest）唯一职责，这里做第二份就会漂移
    check(
        out["defectRows"][1].get("severity") == "p1",
        f"严重度应原样保留报告写法，实际 {out['defectRows'][1].get('severity')!r}",
    )
    check(
        out["defectCounts"] == {"P0": 1, "P1": 1},
        f"聚合计数应大小写归一后统计，实际 {out['defectCounts']!r}",
    )
    check(len(out["rootCauseRows"]) == 1, f"根因表应抽出 1 行，实际 {len(out['rootCauseRows'])}")
    check(
        out["rootCauseRows"][0].get("conclusion") == "产品失败",
        f"未认出根因「结论」列，实际 {out['rootCauseRows'][0]!r}",
    )

    # 列序换一换、表头换个说法 —— 语义相同的等价写法不能让判据翻转
    reordered = """## 缺陷清单

| 严重程度 | 现象 | 位置 |
|---|---|---|
| **P2** | 按钮偏移 | 报告中心 |
"""
    out2 = extract(reordered)
    check(len(out2["defectRows"]) == 1, "列序/表头变化后应仍抽得出缺陷行")
    if out2["defectRows"]:
        row = out2["defectRows"][0]
        check(row.get("module") == "报告中心", f"「位置」应被认成模块列，实际 {row!r}")
        check(row.get("symptom") == "按钮偏移", f"「现象」列未认出，实际 {row!r}")

    # 表头完全没有严重级列时，退而在整行里找 P0-P3（与交互式 HTML 重点卡同款兜底）
    no_header = """## 缺陷清单

| 编号 | 说明 | 等级 |
|---|---|---|
| D-09 | 某处异常 | P3 |
"""
    out3 = extract(no_header)
    check(len(out3["defectRows"]) == 1, "表头无「严重级」时应靠整行兜底找出 P0-P3")

    # 没有这两张表的报告：返回空结构而不是抛异常（大量存量报告没有根因链条表）
    out4 = extract("# 只有正文\n\n没有任何表格。")
    check(out4["defectRows"] == [] and out4["rootCauseRows"] == [], "无表格时应返回空结构")
    check(out4["defectCounts"] == {}, "无缺陷时聚合计数应为空")


def check_upload_wiring(source):
    """提取出来还得真的发出去 —— 这条接线删掉，上面的提取用例仍然全绿。"""
    run_cds = re.search(r"^def run_cds\(.*?^def ", source, re.M | re.S)
    body = run_cds.group(0) if run_cds else ""
    if not body:
        failures.append("找不到 run_cds 函数，无法校验上传接线")
        return
    check(
        "extract_defect_evidence(" in body,
        "run_cds 没有调用 extract_defect_evidence —— 证据解析完就丢，CDS 侧拿不到结构化行",
    )
    for field in ("defectRows", "rootCauseRows", "defectCounts"):
        check(
            re.search(rf'payload\[["\']{field}["\']\]', body) is not None,
            f"run_cds 的 payload 未写入 {field} —— CDS 对未知字段静默丢弃，不会有任何报错",
        )


def check_column_pattern_ssot(source):
    """列识别正则只许有一份定义，否则重点卡与上传证据会各自认列。"""
    for const in ("DEFECT_COL_SEVERITY", "DEFECT_COL_ID", "DEFECT_COL_SYMPTOM", "DEFECT_COL_MODULE"):
        defs = re.findall(rf"^{const}\s*=", source, re.M)
        check(len(defs) == 1, f"{const} 应只定义一次，实际 {len(defs)} 次（判据分裂）")
    # 旧的内联字面量不许复活：它一旦回来，改常量就只改了一半
    check(
        'column_index(defect_headers, r"严重' not in source,
        "交互式 HTML 的列识别又内联回字面量了，请改回引用 DEFECT_COL_* 常量",
    )


def main():
    if not TARGET.exists():
        print(f"[FAIL] 找不到被守文件 {TARGET}")
        return 1
    source = TARGET.read_text(encoding="utf-8")
    check_extraction(load_module())
    check_upload_wiring(source)
    check_column_pattern_ssot(source)

    if failures:
        print(f"[FAIL] 验收结构化缺陷证据守卫 {len(failures)} 项不通过：")
        for item in failures:
            print(f"  - {item}")
        return 1
    print("[OK] 验收结构化缺陷证据守卫通过（提取判据 + 上传接线 + 列正则 SSOT）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
