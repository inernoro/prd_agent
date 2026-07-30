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
            ("核心用例执行失败", {"core-case"}),
            ("核心流程尚未通过", {"core-case"}),
            ("CDS smoke 当前失败", {"smoke"}),
            ("CDS smoke 测试失败", {"smoke"}),
            ("CDS smoke 移动端失败", {"smoke"}),
            ("CDS smoke（移动端）失败", {"smoke"}),
            ("服务尚未就绪", {"service-ready"}),
            ("CDS 服务还没就绪", {"service-ready"}),
            ("CDS 服务还没有就绪", {"service-ready"}),
            ("服务未就绪", {"service-ready"}),
            ("CDS 尚未 ready", {"ready"}),
            ("验收报告归档流程失败", {"archive"}),
            ("Slack 通知发送失败", {"slack"}),
            (
                "CDS smoke 和验收报告归档失败",
                {"smoke", "archive"},
            ),
            (
                "CDS smoke 和验收报告归档失败但构建已修复",
                {"smoke", "archive"},
            ),
            (
                "CDS smoke 失败但构建和验收报告归档已修复",
                {"smoke"},
            ),
            (
                "CDS smoke 已修复但构建和验收报告归档失败",
                {"build", "archive"},
            ),
            (
                "CDS smoke 已修复但失败的构建和验收报告归档",
                {"build", "archive"},
            ),
            (
                "CDS smoke 失败但已修复的构建和验收报告归档",
                {"smoke"},
            ),
            (
                "CDS smoke 和归档失败但 smoke 和构建已修复",
                {"archive"},
            ),
            (
                "失败的 CDS smoke 与验收报告归档",
                {"smoke", "archive"},
            ),
            ("CDS smoke 先前失败，重试后已通过", set()),
            ("CDS smoke 先前失败；现已通过", set()),
            ("CDS smoke 先前失败；验证已通过", set()),
            ("CDS ready 和 smoke 失败；二者均已通过", set()),
            ("CDS smoke 先前失败；但是现已通过", set()),
            ("CDS smoke 失败但现在已修复", set()),
            ("CDS smoke 失败但问题已修复", set()),
            ("CDS smoke 不通过", {"smoke"}),
            ("构建异常", {"build"}),
            ("CDS smoke 执行失败", {"smoke"}),
            ("构建任务失败", {"build"}),
            ("验收报告归档操作执行失败", {"archive"}),
            ("CDS smoke 未能通过", {"smoke"}),
            ("CDS smoke 无法执行", {"smoke"}),
            ("核心用例未能执行", {"core-case"}),
            ("构建未能完成", {"build"}),
            ("验收报告归档未能成功", {"archive"}),
            ("构建尚未通过", {"build"}),
            ("验收报告归档尚未成功", {"archive"}),
            ("CDS smoke 还没完成", {"smoke"}),
            ("CDS smoke 至今未恢复", {"smoke"}),
            ("构建暂时未完成", {"build"}),
            ("CDS ready 尚未就绪", {"ready"}),
            ("CDS smoke 未能恢复", {"smoke"}),
            ("验收报告归档无法恢复", {"archive"}),
            ("CDS smoke 已成功复现失败", {"smoke"}),
            ("CDS smoke 已成功复现出失败", {"smoke"}),
            ("构建已成功重现报错", {"build"}),
            ("构建已经成功地定位到报错", {"build"}),
            ("验收报告归档已成功定位失败", {"archive"}),
            ("CDS smoke 已通过失败场景测试", set()),
            ("CDS smoke 已成功验证异常处理", set()),
            ("验收报告归档已通过失败重试测试", set()),
            (
                "CDS smoke 与构建同时失败",
                {"smoke", "build"},
            ),
            (
                "CDS smoke、构建全部失败",
                {"smoke", "build"},
            ),
            (
                "CDS smoke 与构建均已失败",
                {"smoke", "build"},
            ),
            ("CDS smoke 结果：失败", {"smoke"}),
            ("验收报告归档结果为失败", {"archive"}),
            ("构建状态=异常", {"build"}),
            ("CDS smoke 结果显示为失败", {"smoke"}),
            ("构建被判定为异常", {"build"}),
            ("CDS smoke 状态→失败", {"smoke"}),
            ("CDS smoke 结果：截图上传失败", set()),
            ("CDS smoke 先前失败，问题已解决", set()),
            ("CDS smoke 先前失败，现已正常", set()),
            ("CDS smoke 先前失败，现已成功", set()),
            ("CDS smoke 先前失败，重试后已成功", set()),
            ("CDS smoke 已通过；复测仍未通过", {"smoke"}),
            ("CDS smoke 已通过；移动端验收未完成", set()),
            ("CDS smoke 已通过；移动端验证未通过", set()),
            ("CDS smoke 已通过；截图上传失败", set()),
            ("CDS smoke 已通过但移动端验收未完成", set()),
            ("CDS smoke 已通过但截图上传失败", set()),
            ("CDS smoke 上传失败", set()),
            ("CDS smoke 已通过但复测仍未通过", {"smoke"}),
            ("CDS smoke 已通过；截图上传失败；复测仍未通过", set()),
            ("CDS smoke 已通过；已修复的截图上传仍失败", set()),
            ("CDS smoke 失败；现已修复但移动端验收未完成", set()),
            ("截图上传失败；CDS smoke", set()),
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
            ("CDS smoke 未失败", set()),
            ("CDS smoke 没失败", set()),
            ("CDS smoke 未发生失败", set()),
            ("CDS smoke 超时 0 次", set()),
            ("构建错误数为 0", set()),
            ("CDS smoke 未出现错误", set()),
            ("CDS smoke 并非不通过", set()),
            ("CDS smoke 并非未能通过", set()),
            ("CDS smoke 尚未失败", set()),
            ("CDS smoke 还没有失败", set()),
            ("CDS smoke 并非无法恢复", set()),
            ("构建未出现异常", set()),
            ("构建异常数为 0", set()),
            ("构建错误为零", set()),
            ("CDS smoke 异常为零", set()),
            ("构建错误数为零", set()),
            ("CDS smoke 超时零次", set()),
            ("构建错误数量等于零", set()),
            ("构建错误为〇", set()),
            ("构建错误率为 0.0%", set()),
            ("构建错误是零", set()),
            ("构建错误总数为零", set()),
            ("CDS smoke 异常共零次", set()),
            ("构建错误总计为零", set()),
            ("构建错误为一", {"build"}),
            ("构建错误为零点五", {"build"}),
            ("构建错误为 01", {"build"}),
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

    def test_recommended_known_zero_defect_claim_conflicts_with_p1_fact(self):
        body = report_body("产品失败").replace(
            "未发现可复现产品缺陷，缺陷 0 个",
            "未发现已知缺陷，发现 1 个 P1 登录缺陷",
        )
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

    def test_hard_gate_failure_accepts_explicit_error_states(self):
        for fact in (
            "CDS smoke 超时",
            "构建报错",
            "构建中断",
            "CDS smoke 执行失败",
            "构建任务失败",
            "CDS smoke 未能通过",
            "构建未能完成",
            "构建尚未通过",
            "CDS smoke 还没完成",
            "CDS smoke 至今未恢复",
            "CDS ready 尚未就绪",
            "CDS smoke 未能恢复",
            "CDS smoke 已成功复现失败",
            "CDS smoke 已成功复现出失败",
            "构建已成功重现报错",
            "构建已经成功地定位到报错",
            "CDS smoke 与构建同时失败",
            "CDS smoke、构建全部失败",
            "CDS smoke 与构建均已失败",
            "CDS smoke 结果：失败",
            "构建状态=异常",
            "CDS smoke 结果显示为失败",
            "构建被判定为异常",
        ):
            with self.subTest(fact=fact):
                body = report_body("硬门禁失败").replace(
                    "当前部署 SHA 已前进", fact
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
        for fact in (
            "验收报告归档未成功",
            "验收报告归档操作执行失败",
            "验收报告归档未能成功",
            "报告发布未完成",
            "验收报告归档返回 500",
            "Slack 通知漏发",
        ):
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
            "构建日志没成功确认移动端覆盖",
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
            "CDS smoke 未失败",
            "CDS smoke 没失败",
            "CDS smoke 未发生失败",
            "CDS smoke 超时 0 次",
            "构建错误数为 0",
            "CDS smoke 未出现错误",
            "CDS smoke 并非不通过",
            "CDS smoke 并非未能通过",
            "CDS smoke 尚未失败",
            "CDS smoke 还没有失败",
            "CDS smoke 并非无法恢复",
            "构建未出现异常",
            "构建异常数为 0",
            "构建错误为零",
            "CDS smoke 异常为零",
            "构建错误数为零",
            "CDS smoke 超时零次",
            "构建错误数量等于零",
            "构建错误为〇",
            "构建错误率为 0.0%",
            "构建错误是零",
            "构建错误总数为零",
            "CDS smoke 异常共零次",
            "构建错误总计为零",
        ):
            with self.subTest(fact=fact):
                body = report_body("覆盖不足").replace(
                    "当前部署 SHA 已前进", fact
                )
                errors = archive_report._daily_conclusion_contract_errors(
                    "conditional", body
                )
                self.assertEqual([], errors)

    def test_unregistered_failure_subject_does_not_inherit_previous_gate(self):
        for fact in ("移动端验收未完成", "截图上传失败"):
            for replacement in (
                f"CDS smoke 已通过 | {fact}",
                f"CDS smoke 已通过但{fact} | 预览跟随最新 HEAD",
            ):
                with self.subTest(replacement=replacement):
                    body = report_body("覆盖不足").replace(
                        "当前部署 SHA 已前进 | 预览跟随最新 HEAD",
                        replacement,
                    )
                    errors = archive_report._daily_conclusion_contract_errors(
                        "conditional", body
                    )
                    self.assertEqual([], errors)

    def test_non_fail_verdict_rejects_explicit_error_states(self):
        for fact, label in (
            ("CDS smoke 超时", "硬门禁失败事实"),
            ("CDS smoke 不通过", "硬门禁失败事实"),
            ("构建异常", "硬门禁失败事实"),
            ("CDS smoke 执行失败", "硬门禁失败事实"),
            ("构建任务失败", "硬门禁失败事实"),
            ("CDS smoke 未能通过", "硬门禁失败事实"),
            ("构建未能完成", "硬门禁失败事实"),
            ("验收报告归档操作执行失败", "验收链路失败事实"),
            ("验收报告归档未能成功", "验收链路失败事实"),
            ("构建尚未通过", "硬门禁失败事实"),
            ("CDS smoke 还没完成", "硬门禁失败事实"),
            ("验收报告归档尚未成功", "验收链路失败事实"),
            ("CDS ready 尚未就绪", "硬门禁失败事实"),
            ("CDS smoke 未能恢复", "硬门禁失败事实"),
            ("验收报告归档无法恢复", "验收链路失败事实"),
            ("CDS smoke 已成功复现失败", "硬门禁失败事实"),
            ("CDS smoke 已成功复现出失败", "硬门禁失败事实"),
            ("构建已成功重现报错", "硬门禁失败事实"),
            ("构建已经成功地定位到报错", "硬门禁失败事实"),
            ("CDS smoke 与构建同时失败", "硬门禁失败事实"),
            ("CDS smoke、构建全部失败", "硬门禁失败事实"),
            ("CDS smoke 结果：失败", "硬门禁失败事实"),
            ("构建状态=异常", "硬门禁失败事实"),
            ("验收报告归档结果为失败", "验收链路失败事实"),
            ("验收报告归档返回 500", "验收链路失败事实"),
        ):
            with self.subTest(fact=fact):
                body = report_body("覆盖不足").replace(
                    "当前部署 SHA 已前进", fact
                )
                errors = archive_report._daily_conclusion_contract_errors(
                    "conditional", body
                )
                self.assertTrue(any(label in error for error in errors))

    def test_resolved_historical_failures_do_not_force_fail(self):
        for verdict, nature in (("pass", "完整通过"), ("conditional", "覆盖不足")):
            for fact in (
                "CDS smoke 先前失败但重试后已通过",
                "验收报告归档失败已修复",
                "CDS smoke 先前失败，重试后已通过",
                "验收报告归档失败；现已修复",
                "先前失败的 CDS smoke 现已通过",
                "CDS ready 与 smoke 先前失败，现已通过",
                "CDS smoke 先前失败，问题已解决",
                "CDS smoke 先前失败，现已正常",
                "CDS smoke 先前失败，现已成功",
                "CDS smoke 先前失败，重试后已成功",
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

    def test_verified_failure_scenario_does_not_reopen_gate(self):
        for fact in (
            "CDS smoke 已通过失败场景测试",
            "CDS smoke 已成功验证异常处理",
            "验收报告归档已通过失败重试测试",
            "CDS smoke 已验证异常处理",
        ):
            with self.subTest(fact=fact):
                body = report_body("覆盖不足").replace(
                    "当前部署 SHA 已前进", fact
                )
                errors = archive_report._daily_conclusion_contract_errors(
                    "conditional", body
                )
                self.assertEqual([], errors)

        current_failure = "CDS smoke 已通过失败场景测试但复测仍失败"
        body = report_body("硬门禁失败").replace(
            "当前部署 SHA 已前进", current_failure
        )
        errors = archive_report._daily_conclusion_contract_errors("fail", body)
        self.assertEqual([], errors)

    def test_repaired_artifact_or_pending_delivery_does_not_close_gate(self):
        facts = (
            "CDS smoke 失败；已修复代码仍未部署",
            "构建失败；已修复补丁等待发布",
            "CDS smoke 失败；已修复，补丁等待发布",
            "构建失败；补丁已修复但尚未上线",
        )
        for fact in facts:
            with self.subTest(verdict="conditional", fact=fact):
                body = report_body("覆盖不足").replace(
                    "当前部署 SHA 已前进", fact
                )
                errors = archive_report._daily_conclusion_contract_errors(
                    "conditional", body
                )
                self.assertTrue(any("硬门禁失败事实" in error for error in errors))

            with self.subTest(verdict="fail", fact=fact):
                body = report_body("硬门禁失败").replace(
                    "当前部署 SHA 已前进", fact
                )
                errors = archive_report._daily_conclusion_contract_errors("fail", body)
                self.assertEqual([], errors)

    def test_not_yet_executed_is_coverage_gap_instead_of_failure(self):
        for fact in (
            "CDS smoke 尚未执行",
            "核心用例尚未执行",
            "验收报告归档未执行",
        ):
            with self.subTest(fact=fact):
                body = report_body("覆盖不足").replace(
                    "当前部署 SHA 已前进", fact
                )
                errors = archive_report._daily_conclusion_contract_errors(
                    "conditional", body
                )
                self.assertEqual([], errors)

    def test_gate_closes_only_after_explicit_gate_recovery(self):
        body = report_body("覆盖不足").replace(
            "当前部署 SHA 已前进",
            "CDS smoke 失败；补丁已修复并已部署；CDS smoke 现已通过",
        )
        errors = archive_report._daily_conclusion_contract_errors("conditional", body)
        self.assertEqual([], errors)

    def test_resolved_state_in_later_root_cause_column_closes_failure(self):
        body = report_body("覆盖不足").replace(
            "当前部署 SHA 已前进", "CDS smoke 先前失败"
        ).replace(
            "预览跟随最新 HEAD", "CDS smoke 重试后已通过"
        )
        errors = archive_report._daily_conclusion_contract_errors("conditional", body)
        self.assertEqual([], errors)

    def test_later_root_cause_row_updates_same_subject_state(self):
        cases = (
            ("CDS smoke 先前失败", "CDS smoke 现已通过"),
            ("验收报告归档失败", "验收报告归档现已成功"),
            ("核心用例执行失败", "核心用例现已通过"),
        )
        for failure, closure in cases:
            with self.subTest(failure=failure, closure=closure):
                body = report_body("覆盖不足").replace(
                    "当前部署 SHA 已前进", failure
                )
                body = body.rstrip() + (
                    "\n| 验收冻结 SHA | "
                    f"{closure} | 同一主体已复测 | 关闭旧失败证据 | 已通过 | 保留记录 |\n"
                )
                errors = archive_report._daily_conclusion_contract_errors(
                    "conditional", body
                )
                self.assertEqual([], errors)

    def test_later_root_cause_row_can_reopen_failure(self):
        body = report_body("覆盖不足").replace(
            "当前部署 SHA 已前进", "CDS smoke 现已通过"
        )
        body = body.rstrip() + (
            "\n| 验收冻结 SHA | CDS smoke 再次失败 | 环境回退 | "
            "当前证据证明失败 | 未关闭 | 继续修复 |\n"
        )
        errors = archive_report._daily_conclusion_contract_errors("conditional", body)
        self.assertTrue(any("硬门禁失败事实" in error for error in errors))

    def test_different_root_cause_targets_do_not_close_each_other(self):
        body = report_body("覆盖不足").replace(
            "| 验收冻结 SHA | 当前部署 SHA 已前进 |",
            "| 移动端验收 | CDS smoke 失败 |",
        )
        body = body.rstrip() + (
            "\n| 后端验收 | CDS smoke 已通过 | 后端复测完成 | "
            "仅证明后端 | 已通过 | 保留记录 |\n"
        )
        errors = archive_report._daily_conclusion_contract_errors("conditional", body)
        self.assertTrue(any("硬门禁失败事实" in error for error in errors))

    def test_different_gate_instances_under_same_target_do_not_close_each_other(self):
        body = report_body("覆盖不足").replace(
            "当前部署 SHA 已前进", "移动端 CDS smoke 失败"
        )
        body = body.rstrip() + (
            "\n| 验收冻结 SHA | 后端 CDS smoke 已通过 | 后端复测完成 | "
            "仅证明后端 | 已通过 | 保留记录 |\n"
        )
        errors = archive_report._daily_conclusion_contract_errors("conditional", body)
        self.assertTrue(any("硬门禁失败事实" in error for error in errors))

    def test_same_gate_instance_under_same_target_can_close_failure(self):
        body = report_body("覆盖不足").replace(
            "当前部署 SHA 已前进", "移动端 CDS smoke 失败"
        )
        body = body.rstrip() + (
            "\n| 验收冻结 SHA | 移动端 CDS smoke 已通过 | 移动端复测完成 | "
            "已证明同一实例 | 已通过 | 保留记录 |\n"
        )
        errors = archive_report._daily_conclusion_contract_errors("conditional", body)
        self.assertEqual([], errors)

    def test_parallel_subject_instances_can_be_closed_independently(self):
        body = report_body("覆盖不足").replace(
            "当前部署 SHA 已前进",
            "移动端 CDS smoke 与后端验收报告归档同时失败",
        )
        body = body.rstrip() + (
            "\n| 验收冻结 SHA | 移动端 CDS smoke 已通过 | 移动端复测完成 | "
            "已证明移动端 | 已通过 | 保留记录 |"
            "\n| 验收冻结 SHA | 后端验收报告归档已修复 | 后端复测完成 | "
            "已证明后端 | 已通过 | 保留记录 |\n"
        )
        errors = archive_report._daily_conclusion_contract_errors("conditional", body)
        self.assertEqual([], errors)

    def test_parallel_gate_instances_in_one_row_keep_independent_states(self):
        body = report_body("覆盖不足").replace(
            "当前部署 SHA 已前进",
            "移动端 CDS smoke 失败，后端 CDS smoke 已通过",
        )
        errors = archive_report._daily_conclusion_contract_errors("conditional", body)
        self.assertTrue(any("硬门禁失败事实" in error for error in errors))

    def test_postfixed_gate_instances_keep_independent_states(self):
        body = report_body("覆盖不足").replace(
            "当前部署 SHA 已前进", "CDS smoke（移动端）失败"
        )
        body = body.rstrip() + (
            "\n| 验收冻结 SHA | CDS smoke（后端）已通过 | 后端复测完成 | "
            "仅证明后端 | 已通过 | 保留记录 |\n"
        )
        errors = archive_report._daily_conclusion_contract_errors("conditional", body)
        self.assertTrue(any("硬门禁失败事实" in error for error in errors))

    def test_same_postfixed_gate_instance_can_close_failure(self):
        body = report_body("覆盖不足").replace(
            "当前部署 SHA 已前进", "CDS smoke（移动端）失败"
        )
        body = body.rstrip() + (
            "\n| 验收冻结 SHA | CDS smoke（移动端）已通过 | 移动端复测完成 | "
            "已证明同一实例 | 已通过 | 保留记录 |\n"
        )
        errors = archive_report._daily_conclusion_contract_errors("conditional", body)
        self.assertEqual([], errors)

    def test_subjectless_later_row_does_not_close_prior_failure(self):
        body = report_body("覆盖不足").replace(
            "当前部署 SHA 已前进", "CDS smoke 先前失败"
        )
        body = body.rstrip() + (
            "\n| 其他复测 | 现已通过 | 未注明复测主体 | "
            "不能关联旧失败 | 无法确认 | 补充主体后复测 |\n"
        )
        errors = archive_report._daily_conclusion_contract_errors("conditional", body)
        self.assertTrue(any("硬门禁失败事实" in error for error in errors))

    def test_parallel_failure_subjects_support_each_fail_nature(self):
        for nature in ("硬门禁失败", "验收链路失败"):
            with self.subTest(nature=nature):
                body = report_body(nature).replace(
                    "当前部署 SHA 已前进",
                    "CDS smoke 和验收报告归档失败",
                )
                errors = archive_report._daily_conclusion_contract_errors("fail", body)
                self.assertEqual([], errors)

    def test_parallel_subject_group_allows_instance_qualifiers(self):
        fact = "移动端 CDS smoke 与后端验收报告归档同时失败"
        for nature in ("硬门禁失败", "验收链路失败"):
            with self.subTest(nature=nature):
                body = report_body(nature).replace(
                    "当前部署 SHA 已前进", fact
                )
                errors = archive_report._daily_conclusion_contract_errors("fail", body)
                self.assertEqual([], errors)

        body = report_body("覆盖不足").replace(
            "当前部署 SHA 已前进", fact
        )
        errors = archive_report._daily_conclusion_contract_errors(
            "conditional", body
        )
        error_text = "\n".join(errors)
        self.assertIn("硬门禁", error_text)
        self.assertIn("验收链路", error_text)

    def test_resolved_separate_subject_group_does_not_hide_parallel_failures(self):
        fact = "CDS smoke 和验收报告归档失败但构建已修复"
        for nature in ("硬门禁失败", "验收链路失败"):
            with self.subTest(nature=nature):
                body = report_body(nature).replace("当前部署 SHA 已前进", fact)
                errors = archive_report._daily_conclusion_contract_errors("fail", body)
                self.assertEqual([], errors)

        body = report_body("覆盖不足").replace("当前部署 SHA 已前进", fact)
        errors = archive_report._daily_conclusion_contract_errors(
            "conditional", body
        )
        error_text = "\n".join(errors)
        self.assertIn("硬门禁", error_text)
        self.assertIn("验收链路", error_text)
        self.assertIn("必须使用 fail", error_text)

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
        for conclusion in ("已修复", "已解决", "现已正常"):
            with self.subTest(conclusion=conclusion):
                body = report_body("覆盖不足").replace(
                    "当前部署 SHA 已前进", "验收报告归档失败"
                ).replace(
                    "| 无法确认 | 创建冻结预览后复测 |",
                    f"| {conclusion} | 保留历史记录 |",
                )
                errors = archive_report._daily_conclusion_contract_errors(
                    "conditional", body
                )
                self.assertEqual([], errors)

        body = report_body("覆盖不足").replace(
            "当前部署 SHA 已前进", "CDS smoke 失败"
        ).replace(
            "| 无法确认 | 创建冻结预览后复测 |",
            "| CDS smoke 已修复 | 保留历史记录 |",
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

    def test_root_cause_core_failure_participates_in_verdict_gate(self):
        for verdict, nature in (("pass", "完整通过"), ("conditional", "覆盖不足")):
            for fact in ("核心用例执行失败", "核心流程尚未通过"):
                with self.subTest(verdict=verdict, fact=fact):
                    body = report_body(nature).replace(
                        "当前部署 SHA 已前进", fact
                    )
                    errors = archive_report._daily_conclusion_contract_errors(
                        verdict, body
                    )
                    self.assertTrue(
                        any(
                            "核心用例失败事实" in error
                            and "必须使用 fail" in error
                            for error in errors
                        )
                    )

        for fact in ("核心用例执行失败", "核心流程尚未通过"):
            with self.subTest(verdict="fail", fact=fact):
                body = report_body("核心用例失败").replace(
                    "当前部署 SHA 已前进", fact
                )
                errors = archive_report._daily_conclusion_contract_errors("fail", body)
                self.assertEqual([], errors)

    def test_product_quality_ongoing_core_failure_participates_in_verdict_gate(self):
        facts = (
            "核心用例尚未完成",
            "核心流程未能通过",
            "核心用例超时",
            "核心流程异常",
        )
        for verdict, nature in (("pass", "完整通过"), ("conditional", "覆盖不足")):
            for fact in facts:
                with self.subTest(verdict=verdict, fact=fact):
                    body = report_body(nature).replace(
                        "未发现可复现产品缺陷，缺陷 0 个", fact
                    )
                    errors = archive_report._daily_conclusion_contract_errors(
                        verdict, body
                    )
                    self.assertTrue(
                        any(
                            "核心用例失败事实" in error
                            and "必须使用 fail" in error
                            for error in errors
                        )
                    )

        for fact in facts:
            with self.subTest(verdict="fail", fact=fact):
                body = report_body("核心用例失败").replace(
                    "未发现可复现产品缺陷，缺陷 0 个", fact
                )
                errors = archive_report._daily_conclusion_contract_errors("fail", body)
                self.assertEqual([], errors)

    def test_core_failure_is_independent_from_product_defect_risk(self):
        product_quality = "核心用例执行失败，未发现可复现产品缺陷，缺陷 0 个"
        body = report_body("核心用例失败").replace(
            "未发现可复现产品缺陷，缺陷 0 个", product_quality
        )
        errors = archive_report._daily_conclusion_contract_errors("fail", body)
        self.assertEqual([], errors)

        body = report_body("产品失败").replace(
            "未发现可复现产品缺陷，缺陷 0 个", product_quality
        )
        errors = archive_report._daily_conclusion_contract_errors("fail", body)
        self.assertTrue(
            any("判定性质为产品失败" in error and "没有 P0/P1" in error for error in errors)
        )
        self.assertFalse(any("同时声称缺陷为 0" in error for error in errors))

    def test_quantified_core_failure_participates_in_verdict_gate(self):
        for fact in (
            "核心用例未全部通过",
            "核心流程未全部完成",
            "核心用例尚未完全通过",
            "核心流程未能全量完成",
        ):
            with self.subTest(location="产品质量", fact=fact):
                body = report_body("覆盖不足").replace(
                    "未发现可复现产品缺陷，缺陷 0 个", fact
                )
                errors = archive_report._daily_conclusion_contract_errors(
                    "conditional", body
                )
                self.assertTrue(any("核心用例失败事实" in error for error in errors))

            with self.subTest(location="根因链条", fact=fact):
                body = report_body("覆盖不足").replace(
                    "当前部署 SHA 已前进", fact
                )
                errors = archive_report._daily_conclusion_contract_errors(
                    "conditional", body
                )
                self.assertTrue(any("核心用例失败事实" in error for error in errors))

    def test_resolved_or_negated_product_quality_core_failure_does_not_force_fail(self):
        for fact in (
            "核心用例先前失败，现已通过，缺陷 0 个",
            "核心流程未发生异常，缺陷 0 个",
        ):
            with self.subTest(fact=fact):
                body = report_body("覆盖不足").replace(
                    "未发现可复现产品缺陷，缺陷 0 个", fact
                )
                errors = archive_report._daily_conclusion_contract_errors(
                    "conditional", body
                )
                self.assertEqual([], errors)

    def test_resolved_or_negated_root_cause_core_failure_does_not_force_fail(self):
        for fact in (
            "核心用例先前失败，重试后已通过",
            "核心流程未失败",
        ):
            with self.subTest(fact=fact):
                body = report_body("覆盖不足").replace(
                    "当前部署 SHA 已前进", fact
                )
                errors = archive_report._daily_conclusion_contract_errors(
                    "conditional", body
                )
                self.assertEqual([], errors)

    def test_service_not_ready_participates_in_hard_gate_verdict(self):
        for fact in (
            "服务尚未就绪",
            "CDS 服务还没就绪",
            "CDS 服务还没有就绪",
            "服务未就绪",
            "CDS 尚未 ready",
        ):
            with self.subTest(verdict="conditional", fact=fact):
                body = report_body("覆盖不足").replace(
                    "当前部署 SHA 已前进", fact
                )
                errors = archive_report._daily_conclusion_contract_errors(
                    "conditional", body
                )
                self.assertTrue(
                    any(
                        "硬门禁失败事实" in error and "必须使用 fail" in error
                        for error in errors
                    )
                )

            with self.subTest(verdict="fail", fact=fact):
                body = report_body("硬门禁失败").replace(
                    "当前部署 SHA 已前进", fact
                )
                errors = archive_report._daily_conclusion_contract_errors("fail", body)
                self.assertEqual([], errors)

        for fact in (
            "服务尚未就绪，随后已恢复",
            "服务尚未就绪，现已就绪",
            "CDS 尚未 ready，现已 ready",
        ):
            with self.subTest(verdict="conditional", fact=fact):
                body = report_body("覆盖不足").replace(
                    "当前部署 SHA 已前进", fact
                )
                errors = archive_report._daily_conclusion_contract_errors(
                    "conditional", body
                )
                self.assertEqual([], errors)

        for closure in (
            "服务现已就绪",
            "服务已经就绪",
            "服务最终已就绪",
            "服务随后已就绪",
            "服务重试后已就绪",
        ):
            with self.subTest(verdict="conditional", closure=closure):
                body = report_body("覆盖不足").replace(
                    "当前部署 SHA 已前进", "服务尚未就绪"
                )
                body = body.rstrip() + (
                    "\n| 验收冻结 SHA | "
                    f"{closure} | 已完成复测 | 旧失败已关闭 | 已通过 | 保留记录 |\n"
                )
                errors = archive_report._daily_conclusion_contract_errors(
                    "conditional", body
                )
                self.assertEqual([], errors)

    def test_not_yet_fixed_participates_in_fail_only_verdicts(self):
        cases = (
            ("构建尚未修复", "硬门禁失败", "硬门禁失败事实"),
            ("CDS smoke 仍未修复", "硬门禁失败", "硬门禁失败事实"),
            (
                "验收报告归档故障尚未修复",
                "验收链路失败",
                "验收链路失败事实",
            ),
        )
        for fact, fail_nature, label in cases:
            with self.subTest(verdict="conditional", fact=fact):
                body = report_body("覆盖不足").replace(
                    "当前部署 SHA 已前进", fact
                )
                errors = archive_report._daily_conclusion_contract_errors(
                    "conditional", body
                )
                self.assertTrue(
                    any(label in error and "必须使用 fail" in error for error in errors)
                )

            with self.subTest(verdict="fail", fact=fact):
                body = report_body(fail_nature).replace(
                    "当前部署 SHA 已前进", fact
                )
                errors = archive_report._daily_conclusion_contract_errors("fail", body)
                self.assertEqual([], errors)

        for fact in (
            "构建尚未修复，现已修复",
            "CDS smoke 仍未正常，现已正常",
            "验收报告归档故障尚未修复，随后已修复",
        ):
            with self.subTest(verdict="conditional", fact=fact):
                body = report_body("覆盖不足").replace(
                    "当前部署 SHA 已前进", fact
                )
                errors = archive_report._daily_conclusion_contract_errors(
                    "conditional", body
                )
                self.assertEqual([], errors)

    def test_conclusion_column_participates_in_failure_state(self):
        cases = (
            ("CDS smoke 当前失败", "硬门禁失败", "硬门禁"),
            ("构建报错", "硬门禁失败", "硬门禁"),
            ("验收报告归档失败", "验收链路失败", "验收链路"),
        )
        for fact, fail_nature, label in cases:
            with self.subTest(fact=fact, verdict="conditional"):
                body = report_body("覆盖不足").replace(
                    "| 无法确认 | 创建冻结预览后复测 |",
                    f"| {fact} | 创建冻结预览后复测 |",
                )
                errors = archive_report._daily_conclusion_contract_errors(
                    "conditional", body
                )
                error_text = "\n".join(errors)
                self.assertIn(label, error_text)
                self.assertIn("必须使用 fail", error_text)

            with self.subTest(fact=fact, verdict="fail"):
                body = report_body(fail_nature).replace(
                    "| 无法确认 | 创建冻结预览后复测 |",
                    f"| {fact} | 创建冻结预览后复测 |",
                )
                errors = archive_report._daily_conclusion_contract_errors(
                    "fail", body
                )
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


if __name__ == "__main__":
    unittest.main()
