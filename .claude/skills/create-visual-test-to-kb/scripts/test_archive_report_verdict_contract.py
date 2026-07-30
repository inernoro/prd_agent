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
    def test_failure_state_machine_tracks_subjects_across_word_orders(self):
        cases = (
            ("CDS smoke 当前失败", {"smoke"}),
            (
                "CDS smoke 和验收报告归档失败",
                {"smoke", "archive"},
            ),
            (
                "失败的 CDS smoke 与验收报告归档",
                {"smoke", "archive"},
            ),
            ("CDS smoke 先前失败，重试后已通过", set()),
            ("先前失败的 CDS smoke 现已通过", set()),
            (
                "CDS smoke 先前失败，已修复，完成部署后，复测仍未通过",
                {"smoke"},
            ),
            ("CDS smoke 当前失败，归档已修复", {"smoke"}),
            (
                "验收报告归档失败但 CDS 报告 API 已恢复",
                {"archive"},
            ),
            ("CDS smoke 失败并非已修复", {"smoke"}),
            ("CDS smoke 失败不是已修复问题", {"smoke"}),
            ("CDS smoke 失败但“已修复”并非事实", {"smoke"}),
            ("CDS smoke 失败，该问题现已修复", set()),
            ("CDS smoke 失败，服务恢复后现已通过", set()),
            ("CDS smoke 并未失败", set()),
            ("CDS smoke 没有失败", set()),
            ("CDS smoke 并非不可用", set()),
            ("没有发现 CDS smoke 失败", set()),
            ("未检测到 CDS smoke 失败", set()),
            ("验收报告归档失败；现已修复", set()),
            ("报告无法归档", {"archive"}),
            ("无法完成报告发布", {"report-publish"}),
        )
        for fact, expected in cases:
            with self.subTest(fact=fact):
                self.assertEqual(
                    expected,
                    archive_report._current_failure_subjects(fact),
                )

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

    def test_partial_severity_counts_preserve_explicit_zero_defect_claim(self):
        body = report_body("非阻断风险").replace(
            "未发现可复现产品缺陷，缺陷 0 个",
            "未发现可复现产品缺陷，P0: 0，P1: 0",
        ) + """
## 缺陷清单

| ID | 严重级 | 现象 |
|---|---|---|
| D-1 | P2 | 非阻断体验问题 |
"""
        errors = archive_report._daily_conclusion_contract_errors("conditional", body)
        self.assertTrue(any("同时声称缺陷为 0" in error for error in errors))

    def test_scoped_zero_defect_claim_does_not_override_nonzero_severity(self):
        for quality in (
            "P0: 1，P1: 0，未发现 P2/P3 产品缺陷",
            "P0: 1，未发现其他产品缺陷",
        ):
            with self.subTest(quality=quality):
                body = report_body("产品失败").replace(
                    "未发现可复现产品缺陷，缺陷 0 个", quality
                )
                errors = archive_report._daily_conclusion_contract_errors("fail", body)
                self.assertEqual([], errors)

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

    def test_hard_gate_failure_accepts_failure_before_subject(self):
        body = report_body("硬门禁失败").replace(
            "当前部署 SHA 已前进 | 预览跟随最新 HEAD",
            "无法完成构建 | 编译环境不可用",
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

    def test_acceptance_chain_failure_accepts_failure_before_subject(self):
        for fact in ("报告无法归档", "无法完成报告发布"):
            with self.subTest(fact=fact):
                body = report_body("验收链路失败").replace(
                    "当前部署 SHA 已前进 | 预览跟随最新 HEAD",
                    f"{fact} | CDS 报告 API 不可用",
                )
                errors = archive_report._daily_conclusion_contract_errors("fail", body)
                self.assertEqual([], errors)

    def test_acceptance_chain_failure_accepts_unsuccessful_states(self):
        for fact in ("验收报告归档未成功", "报告发布未完成"):
            with self.subTest(fact=fact):
                body = report_body("验收链路失败").replace(
                    "当前部署 SHA 已前进", fact
                )
                errors = archive_report._daily_conclusion_contract_errors("fail", body)
                self.assertEqual([], errors)

    def test_coverage_uncertainty_is_not_acceptance_chain_failure(self):
        for fact in (
            "无法确认报告归档是否覆盖移动端",
            "无法确认 Slack 通知是否送达所有频道",
            "无法检测报告发布是否覆盖旧浏览器",
        ):
            with self.subTest(fact=fact):
                body = report_body("覆盖不足").replace(
                    "当前部署 SHA 已前进", fact
                )
                errors = archive_report._daily_conclusion_contract_errors(
                    "conditional", body
                )
                self.assertEqual([], errors)

    def test_evidence_unavailable_for_confirmation_is_not_chain_failure(self):
        for fact in (
            "当前截图不可用于验证报告发布是否覆盖移动端",
            "现有证据不可用于确认 Slack 通知覆盖全部频道",
            "构建日志不可用于确认移动端覆盖",
            "构建日志未成功确认移动端覆盖",
        ):
            with self.subTest(fact=fact):
                body = report_body("覆盖不足").replace(
                    "当前部署 SHA 已前进", fact
                )
                errors = archive_report._daily_conclusion_contract_errors(
                    "conditional", body
                )
                self.assertEqual([], errors)

    def test_evidence_usage_gap_does_not_hide_real_build_failure(self):
        body = report_body("硬门禁失败").replace(
            "当前部署 SHA 已前进",
            "构建失败且日志不可用于确认移动端覆盖",
        )
        errors = archive_report._daily_conclusion_contract_errors("fail", body)
        self.assertEqual([], errors)

        for fact in (
            "构建产物不可用于发布且日志不足以确认移动端覆盖",
            "截图显示构建产物不可用于发布且日志不足以确认移动端覆盖",
            "截图显示构建未成功且日志不足以确认移动端覆盖",
        ):
            with self.subTest(fact=fact):
                conditional_body = report_body("覆盖不足").replace(
                    "当前部署 SHA 已前进", fact
                )
                conditional_errors = archive_report._daily_conclusion_contract_errors(
                    "conditional", conditional_body
                )
                self.assertTrue(
                    any("硬门禁失败事实" in error for error in conditional_errors)
                )

    def test_negated_failure_does_not_force_fail(self):
        for fact in (
            "CDS smoke 并未失败",
            "CDS smoke 没有失败",
            "CDS smoke 并非不可用",
            "没有发现 CDS smoke 失败",
            "未检测到 CDS smoke 失败",
        ):
            with self.subTest(fact=fact):
                body = report_body("覆盖不足").replace(
                    "当前部署 SHA 已前进", fact
                )
                errors = archive_report._daily_conclusion_contract_errors(
                    "conditional", body
                )
                self.assertEqual([], errors)

    def test_resolved_historical_failures_do_not_force_fail(self):
        for verdict, nature in (("pass", "完整通过"), ("conditional", "覆盖不足")):
            for fact in (
                "CDS smoke 先前失败但重试后已通过",
                "验收报告归档失败已修复",
                "CDS smoke 先前失败，重试后已通过",
                "验收报告归档失败；现已修复",
                "先前失败的 CDS smoke 现已通过",
                "CDS ready 与 smoke 先前失败，现已通过",
            ):
                with self.subTest(verdict=verdict, fact=fact):
                    body = report_body(nature).replace(
                        "当前部署 SHA 已前进", fact
                    )
                    errors = archive_report._daily_conclusion_contract_errors(
                        verdict, body
                    )
                    self.assertEqual([], errors)

    def test_resolved_adjacent_subject_does_not_hide_current_failure(self):
        body = report_body("硬门禁失败").replace(
            "当前部署 SHA 已前进",
            "CDS smoke 当前失败，归档已修复",
        )
        errors = archive_report._daily_conclusion_contract_errors("fail", body)
        self.assertEqual([], errors)

    def test_resolved_state_in_later_root_cause_column_closes_failure(self):
        body = report_body("覆盖不足").replace(
            "当前部署 SHA 已前进", "CDS smoke 先前失败"
        ).replace(
            "预览跟随最新 HEAD", "CDS smoke 重试后已通过"
        )
        errors = archive_report._daily_conclusion_contract_errors("conditional", body)
        self.assertEqual([], errors)

    def test_parallel_failure_subjects_support_each_fail_nature(self):
        for nature in ("硬门禁失败", "验收链路失败"):
            with self.subTest(nature=nature):
                body = report_body(nature).replace(
                    "当前部署 SHA 已前进",
                    "CDS smoke 和验收报告归档失败",
                )
                errors = archive_report._daily_conclusion_contract_errors("fail", body)
                self.assertEqual([], errors)

    def test_partially_resolved_status_does_not_hide_current_failure(self):
        for conclusion in (
            "部分已修复，仍有阻断",
            "归档已修复，但 smoke 仍失败",
        ):
            with self.subTest(conclusion=conclusion):
                body = report_body("硬门禁失败").replace(
                    "当前部署 SHA 已前进", "CDS smoke 未通过"
                ).replace(
                    "| 无法确认 | 创建冻结预览后复测 |",
                    f"| {conclusion} | 继续处理未关闭项 |",
                )
                errors = archive_report._daily_conclusion_contract_errors("fail", body)
                self.assertEqual([], errors)

    def test_resolved_root_cause_status_does_not_force_fail(self):
        body = report_body("覆盖不足").replace(
            "当前部署 SHA 已前进", "验收报告归档失败"
        ).replace(
            "| 无法确认 | 创建冻结预览后复测 |",
            "| 已修复 | 保留历史记录 |",
        )
        errors = archive_report._daily_conclusion_contract_errors("conditional", body)
        self.assertEqual([], errors)

    def test_future_closing_action_does_not_resolve_current_failure(self):
        for action in (
            "重试后恢复服务",
            "随后修复构建环境",
            "最终恢复服务并重试",
        ):
            with self.subTest(action=action):
                body = report_body("硬门禁失败").replace(
                    "当前部署 SHA 已前进", "CDS smoke 未通过"
                ).replace(
                    "创建冻结预览后复测", action
                )
                errors = archive_report._daily_conclusion_contract_errors("fail", body)
                self.assertEqual([], errors)

    def test_future_recovery_phrase_in_fact_does_not_resolve_failure(self):
        for fact in (
            "CDS smoke 当前失败，重试后恢复服务",
            "CDS smoke 当前失败，计划恢复正常",
        ):
            with self.subTest(fact=fact):
                body = report_body("硬门禁失败").replace(
                    "当前部署 SHA 已前进", fact
                )
                errors = archive_report._daily_conclusion_contract_errors("fail", body)
                self.assertEqual([], errors)

    def test_later_failure_in_same_clause_is_not_treated_as_resolved(self):
        for fact in (
            "CDS smoke 失败已修复但复测仍未通过",
            "CDS smoke 失败已修复，但复测仍未通过",
            "CDS smoke 先前失败，重试后已通过，但复测仍未通过",
            "CDS smoke 先前失败，已修复，完成部署后，复测仍未通过",
        ):
            with self.subTest(fact=fact):
                body = report_body("硬门禁失败").replace(
                    "当前部署 SHA 已前进", fact
                )
                errors = archive_report._daily_conclusion_contract_errors("fail", body)
                self.assertEqual([], errors)

    def test_non_fail_verdicts_reject_fail_only_facts(self):
        cases = (
            (
                "核心用例",
                lambda body: body.replace(
                    "未发现可复现产品缺陷，缺陷 0 个", "核心用例执行失败"
                ),
            ),
            (
                "验收链路",
                lambda body: body.replace(
                    "当前部署 SHA 已前进 | 预览跟随最新 HEAD",
                    "验收报告归档失败 | CDS 报告 API 不可用",
                ),
            ),
            (
                "硬门禁",
                lambda body: body.replace(
                    "当前部署 SHA 已前进 | 预览跟随最新 HEAD",
                    "CDS smoke 未通过 | API 持续返回 500",
                ),
            ),
        )
        for verdict, nature in (("pass", "完整通过"), ("conditional", "覆盖不足")):
            for label, inject_fact in cases:
                with self.subTest(verdict=verdict, label=label):
                    errors = archive_report._daily_conclusion_contract_errors(
                        verdict, inject_fact(report_body(nature))
                    )
                    self.assertTrue(
                        any(
                            f"verdict={verdict}" in error
                            and f"{label}失败事实" in error
                            and "必须使用 fail" in error
                            for error in errors
                        )
                    )

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


if __name__ == "__main__":
    unittest.main()
