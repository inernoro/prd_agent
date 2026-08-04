import importlib.util
import pathlib
import unittest


SCRIPT = pathlib.Path(__file__).with_name("archive_report.py")
TEMPLATES = SCRIPT.parent.parent / "templates"
SPEC = importlib.util.spec_from_file_location("archive_report", SCRIPT)
archive_report = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(archive_report)


def report_body(nature: str) -> str:
    overall = {
        "完整通过": "pass（通过）",
        "覆盖不足": "conditional（有条件通过）",
        "非阻断风险": "conditional（有条件通过）",
        "产品失败": "fail（不通过）",
        "核心用例失败": "fail（不通过）",
        "验收链路失败": "fail（不通过）",
        "硬门禁失败": "fail（不通过）",
    }[nature]
    completeness = "完整，全部计划范围均已确认" if nature == "完整通过" else "不完整，1 项无法确认"
    return f"""
## 结论分层

| 结论维度 | 结果 |
|---|---|
| 产品质量 | 未发现可复现产品缺陷，缺陷 0 个 |
| 验收完整性 | {completeness} |
| 综合结论 | {overall} |
| 发布建议 | main 可继续，未发布分支暂不作质量承诺 |
| 判定性质 | {nature} |

## 根因链条

| 目标要求 | 观察事实 | 系统原因 | 证据影响 | 结论 | 关闭动作 |
|---|---|---|---|---|---|
| 验收冻结 SHA | 当前部署 SHA 已前进 | 预览跟随最新 HEAD | 当前截图不能证明冻结版本 | 无法确认 | 创建冻结预览后复测 |
"""


class DailyVerdictContractTests(unittest.TestCase):
    def test_shipped_templates_have_one_exact_conclusion_section(self):
        for template_name in ("zz-report.md", "report-template.md"):
            with self.subTest(template=template_name):
                body = (TEMPLATES / template_name).read_text(encoding="utf-8")
                self.assertEqual(1, body.splitlines().count("## 结论分层"))
                rows = archive_report._section_table_rows(body, "结论分层")
                fields = {row[0].strip() for row in rows if row}
                self.assertEqual(set(archive_report.DAILY_CONCLUSION_FIELDS), fields)

    def test_shipped_templates_have_one_exact_root_cause_section(self):
        for template_name in ("zz-report.md", "report-template.md"):
            with self.subTest(template=template_name):
                body = (TEMPLATES / template_name).read_text(encoding="utf-8")
                self.assertEqual(1, body.splitlines().count("## 根因链条"))
                rows = archive_report._section_table_rows(body, "根因链条")
                self.assertEqual(1, len(rows))
                self.assertEqual(len(archive_report.DAILY_ROOT_CAUSE_FIELDS), len(rows[0]))

    def test_coverage_only_fail_is_rejected(self):
        errors = archive_report._daily_conclusion_contract_errors(
            "fail", report_body("覆盖不足")
        )
        self.assertTrue(any("必须用 conditional" in error for error in errors))

    def test_coverage_only_conditional_is_accepted(self):
        errors = archive_report._daily_conclusion_contract_errors(
            "conditional", report_body("覆盖不足")
        )
        self.assertEqual([], errors)

    def test_product_failure_can_use_fail(self):
        body = report_body("产品失败").replace(
            "未发现可复现产品缺陷，缺陷 0 个", "发现 1 个 P1 产品缺陷"
        )
        errors = archive_report._daily_conclusion_contract_errors("fail", body)
        self.assertEqual([], errors)

    def test_coverage_only_cannot_be_relabelled_product_failure(self):
        errors = archive_report._daily_conclusion_contract_errors(
            "fail", report_body("产品失败")
        )
        self.assertTrue(any("没有 P0/P1 产品失败事实" in error for error in errors))
        self.assertTrue(any("必须使用 conditional" in error for error in errors))

    def test_blocking_product_defect_cannot_be_conditional(self):
        body = report_body("覆盖不足").replace(
            "未发现可复现产品缺陷，缺陷 0 个", "发现 1 个 P1 产品缺陷"
        )
        errors = archive_report._daily_conclusion_contract_errors("conditional", body)
        self.assertTrue(any("必须使用 fail" in error for error in errors))

    def test_p2_only_defect_can_remain_conditional(self):
        body = report_body("非阻断风险").replace(
            "未发现可复现产品缺陷，缺陷 0 个", "发现 1 个 P2 产品缺陷"
        ) + """
## 缺陷清单

| ID | 严重级 | 现象 |
|---|---|---|
| D-1 | P2 | 非阻断体验问题 |
"""
        errors = archive_report._daily_conclusion_contract_errors("conditional", body)
        self.assertEqual([], errors)

    def test_p1_in_severity_vector_cannot_be_conditional(self):
        body = report_body("覆盖不足").replace(
            "未发现可复现产品缺陷，缺陷 0 个", "P0/P1/P2/P3: 0/1/0/0"
        )
        errors = archive_report._daily_conclusion_contract_errors("conditional", body)
        self.assertTrue(any("必须使用 fail" in error for error in errors))
        self.assertFalse(any("同时声称缺陷为 0" in error for error in errors))

    def test_p2_in_severity_vector_can_remain_conditional(self):
        body = report_body("非阻断风险").replace(
            "未发现可复现产品缺陷，缺陷 0 个", "P0/P1/P2/P3: 0/0/1/0"
        )
        errors = archive_report._daily_conclusion_contract_errors("conditional", body)
        self.assertEqual([], errors)

    def test_zero_defect_claim_conflicts_with_blocking_defect_table(self):
        body = report_body("产品失败") + """
## 缺陷清单

| ID | 严重级 | 现象 |
|---|---|---|
| D-1 | P1 | 保存动作稳定失败 |
"""
        errors = archive_report._daily_conclusion_contract_errors("fail", body)
        self.assertTrue(any("同时声称缺陷为 0" in error for error in errors))

    def test_hard_gate_failure_requires_hard_gate_fact(self):
        errors = archive_report._daily_conclusion_contract_errors(
            "fail", report_body("硬门禁失败")
        )
        self.assertTrue(any("没有 ready、smoke、构建或强制测试失败事实" in error for error in errors))
        self.assertTrue(any("必须使用 conditional" in error for error in errors))

    def test_hard_gate_failure_with_smoke_fact_can_use_fail(self):
        body = report_body("硬门禁失败").replace(
            "当前部署 SHA 已前进 | 预览跟随最新 HEAD",
            "CDS smoke 未通过 | API 持续返回 500",
        )
        errors = archive_report._daily_conclusion_contract_errors("fail", body)
        self.assertEqual([], errors)

    def test_acceptance_chain_failure_requires_chain_fact(self):
        errors = archive_report._daily_conclusion_contract_errors(
            "fail", report_body("验收链路失败")
        )
        self.assertTrue(any("没有归档、打开验证或通知链路失败事实" in error for error in errors))

    def test_acceptance_chain_failure_with_archive_fact_can_use_fail(self):
        body = report_body("验收链路失败").replace(
            "当前部署 SHA 已前进 | 预览跟随最新 HEAD",
            "验收报告归档失败 | CDS 报告 API 不可用",
        )
        errors = archive_report._daily_conclusion_contract_errors("fail", body)
        self.assertEqual([], errors)

    def test_missing_root_cause_chain_is_rejected(self):
        body = report_body("覆盖不足").split("## 根因链条", 1)[0]
        errors = archive_report._daily_conclusion_contract_errors("conditional", body)
        self.assertTrue(any("根因链条" in error for error in errors))

    def test_pass_does_not_require_root_cause_chain(self):
        body = report_body("完整通过").split("## 根因链条", 1)[0]
        errors = archive_report._daily_conclusion_contract_errors("pass", body)
        self.assertEqual([], errors)

    def test_pass_is_rejected_when_completeness_is_incomplete(self):
        body = report_body("完整通过").replace(
            "完整，全部计划范围均已确认", "不完整，1 项无法确认"
        )
        errors = archive_report._daily_conclusion_contract_errors("pass", body)
        self.assertTrue(any("pass 与未覆盖" in error for error in errors))

    def test_pass_is_rejected_when_coverage_table_has_gap(self):
        body = report_body("完整通过") + """
## 覆盖缺口

| ID | 未覆盖范围 |
|---|---|
| G1 | 冻结 SHA 无法复现 |
"""
        errors = archive_report._daily_conclusion_contract_errors("pass", body)
        self.assertTrue(any("声称完整" in error for error in errors))
        self.assertTrue(any("pass 与未覆盖" in error for error in errors))

    def test_zero_gap_wording_is_not_treated_as_incomplete(self):
        body = report_body("完整通过").replace(
            "完整，全部计划范围均已确认", "完整，无法确认 0 项，未覆盖 0 项"
        )
        errors = archive_report._daily_conclusion_contract_errors("pass", body)
        self.assertEqual([], errors)

    def test_overall_conclusion_accepts_slash_separator(self):
        body = report_body("覆盖不足").replace(
            "conditional（有条件通过）", "conditional / 有条件通过"
        )
        errors = archive_report._daily_conclusion_contract_errors("conditional", body)
        self.assertEqual([], errors)

    def test_malformed_root_cause_data_row_is_rejected(self):
        body = report_body("覆盖不足").replace(
            "| 验收冻结 SHA | 当前部署 SHA 已前进 | 预览跟随最新 HEAD | 当前截图不能证明冻结版本 | 无法确认 | 创建冻结预览后复测 |",
            "| 无 |",
        )
        errors = archive_report._daily_conclusion_contract_errors("conditional", body)
        self.assertTrue(any("完整填写六列" in error for error in errors))

    def test_root_cause_header_must_match_contract(self):
        body = report_body("覆盖不足").replace("| 结论 | 关闭动作 |", "| 结论 | 后续 |")
        errors = archive_report._daily_conclusion_contract_errors("conditional", body)
        self.assertTrue(any("表头必须严格为" in error for error in errors))

    def test_not_run_report_requires_execution_coverage_ledger(self):
        errors = archive_report._coverage_ledger_errors("未执行：12\nVerdict: conditional")
        self.assertTrue(any("执行覆盖账本" in error for error in errors))

    def test_execution_coverage_ledger_requires_actionable_fields(self):
        body = """
未执行：1

## 执行覆盖账本

| 环境 | 计划 | 已执行 | 通过 | 失败 | 未执行 | 阻塞类别 | 直接执行路径 |
|---|---:|---:|---:|---:|---:|---|---|
| CDS 环境 | 2 | 1 | 1 | 0 | 1 | 自动化缺口 | run command |

| caseId | 为什么未执行 | 关闭条件 |
|---|---|---|
| REC-001 | 缺真实步骤 | 出现执行证据 |
"""
        self.assertEqual([], archive_report._coverage_ledger_errors(body))

    def test_execution_coverage_ledger_rejects_missing_close_condition(self):
        body = """
not-run

## 执行覆盖账本

| 计划 | 已执行 | 通过 | 失败 | 未执行 | 阻塞类别 | 直接执行路径 |
|---|---|---|---|---|---|---|
| 2 | 1 | 1 | 0 | 1 | 自动化缺口 | run command |
"""
        errors = archive_report._coverage_ledger_errors(body)
        self.assertTrue(any("关闭条件" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
