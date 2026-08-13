import importlib.util
import pathlib
import unittest


SCRIPT = pathlib.Path(__file__).with_name("archive_report.py")
TEMPLATES = SCRIPT.parent.parent / "templates"
STANDARD = SCRIPT.parent.parent / "reference" / "standard-v2.md"
REPO_ROOT = SCRIPT.parents[4]
ENTERPRISE_RULE = REPO_ROOT / "doc" / "rule.acceptance.map-enterprise.md"
SPEC = importlib.util.spec_from_file_location("archive_report", SCRIPT)
archive_report = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(archive_report)


def report_body(nature: str, counts=(0, 0, 0, 0)) -> str:
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
    root_conclusion = {
        "完整通过": "通过",
        "覆盖不足": "覆盖缺口",
        "非阻断风险": "非阻断风险",
        "产品失败": "产品失败",
        "核心用例失败": "核心用例失败",
        "验收链路失败": "验收链路失败",
        "硬门禁失败": "硬门禁失败",
    }[nature]
    core_case_result = "失败" if nature == "核心用例失败" else "通过"
    total = sum(counts)
    highest = next((f"P{index}" for index, count in enumerate(counts) if count), "无")
    product_quality = (
        f"未发现可复现产品缺陷，缺陷 0 个；P0/P1/P2/P3={counts[0]}/{counts[1]}/{counts[2]}/{counts[3]}；"
        if total == 0
        else f"发现 {total} 个产品缺陷，最高 {highest}；P0/P1/P2/P3={counts[0]}/{counts[1]}/{counts[2]}/{counts[3]}；"
    )
    summaries = ["无" if count == 0 else f"{severity} 代表性问题" for severity, count in zip(archive_report.DAILY_SEVERITY_LEVELS, counts)]
    broken = counts[0] + counts[1] > 0 or nature == "核心用例失败"
    unconfirmed = nature in {"验收链路失败", "硬门禁失败"}
    if broken:
        plain_product = "有功能坏了，用户点进去会失败"
    elif nature == "完整通过" and not unconfirmed:
        plain_product = "可以正常使用，走了一遍没发现问题"
    else:
        plain_product = "这次没测出来，不能保证"
    plain_complete = "测完了" if nature == "完整通过" else "没测完，缺 1 项"
    return f"""
## {archive_report.PLAIN_SUMMARY_SECTION}

| 你要知道的 | 答案 |
|---|---|
| 产品能不能用 | {plain_product} |
| 验收测完了吗 | {plain_complete} |
| 昨天上了什么 | 录音页面新增自动续录；周报页面加了导出按钮 |
| 需要你决定什么 | {archive_report.PLAIN_NO_DECISION} |
| 下面的内容 | 都是给工程师看的技术细节，你可以不看 |

## 结论分层

| 结论维度 | 结果 |
|---|---|
| 产品质量 | {product_quality}核心用例={core_case_result} |
| 验收完整性 | {completeness} |
| 综合结论 | {overall} |
| 发布建议 | main 可继续，未发布分支暂不作质量承诺 |
| 判定性质 | {nature} |

## 缺陷分级速览

| 严重级 | 数量 | 问题概述 |
|---|---:|---|
| P0 | {counts[0]} | {summaries[0]} |
| P1 | {counts[1]} | {summaries[1]} |
| P2 | {counts[2]} | {summaries[2]} |
| P3 | {counts[3]} | {summaries[3]} |

## 根因链条

| 目标要求 | 观察事实 | 系统原因 | 证据影响 | 结论 | 关闭动作 |
|---|---|---|---|---|---|
| 验收冻结 SHA | 当前部署 SHA 已前进 | 预览跟随最新 HEAD | 当前截图不能证明冻结版本 | {root_conclusion} | 创建冻结预览后复测 |
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

    def test_shipped_templates_require_structured_core_case_result(self):
        for template_name in ("zz-report.md", "report-template.md"):
            with self.subTest(template=template_name):
                body = (TEMPLATES / template_name).read_text(encoding="utf-8")
                values = {
                    row[0].strip(): row[1].strip()
                    for row in archive_report._section_table_rows(body, "结论分层")
                    if len(row) >= 2
                }
                self.assertIn("核心用例=通过/失败/未执行", values["产品质量"])
                self.assertIn("P0/P1/P2/P3=0/0/0/0", values["产品质量"])

    def test_shipped_templates_have_glanceable_severity_summary(self):
        for template_name in ("zz-report.md", "report-template.md"):
            with self.subTest(template=template_name):
                body = (TEMPLATES / template_name).read_text(encoding="utf-8")
                self.assertEqual(1, body.splitlines().count("## 缺陷分级速览"))
                headers, rows = archive_report._section_table(body, "缺陷分级速览")
                self.assertEqual(list(archive_report.DAILY_SEVERITY_SUMMARY_FIELDS), headers)
                self.assertEqual(list(archive_report.DAILY_SEVERITY_LEVELS), [row[0] for row in rows])

    def test_missing_severity_summary_is_rejected(self):
        body = report_body("覆盖不足")
        start = body.index("## 缺陷分级速览")
        end = body.index("## 根因链条")
        errors = archive_report._daily_conclusion_contract_errors(
            "conditional", body[:start] + body[end:]
        )
        self.assertTrue(any("缺陷分级速览" in error for error in errors))

    def test_nonzero_severity_requires_problem_overview(self):
        body = report_body("非阻断风险", counts=(0, 0, 1, 0)).replace(
            "| P2 | 1 | P2 代表性问题 |", "| P2 | 1 | 详见报告 |"
        )
        errors = archive_report._daily_conclusion_contract_errors("conditional", body)
        self.assertTrue(any("不能只给数量" in error for error in errors))

    def test_severity_summary_must_match_product_quality_vector(self):
        body = report_body("非阻断风险", counts=(0, 0, 1, 0)).replace(
            "P0/P1/P2/P3=0/0/1/0", "P0/P1/P2/P3=0/0/0/1"
        )
        errors = archive_report._daily_conclusion_contract_errors("conditional", body)
        self.assertTrue(any("数量与「缺陷分级速览」不一致" in error for error in errors))

    def test_shipped_templates_have_one_exact_root_cause_section(self):
        for template_name in ("zz-report.md", "report-template.md"):
            with self.subTest(template=template_name):
                body = (TEMPLATES / template_name).read_text(encoding="utf-8")
                self.assertEqual(1, body.splitlines().count("## 根因链条"))
                rows = archive_report._section_table_rows(body, "根因链条")
                self.assertEqual(1, len(rows))
                self.assertEqual(len(archive_report.DAILY_ROOT_CAUSE_FIELDS), len(rows[0]))
                conclusions = set(rows[0][4].strip("{}").split("/"))
                self.assertEqual(archive_report.ROOT_CAUSE_CONCLUSIONS, conclusions)

    def test_standard_root_cause_template_uses_exact_conclusions(self):
        body = STANDARD.read_text(encoding="utf-8")
        rows = archive_report._section_table_rows(body, "根因链条")
        self.assertEqual(1, len(rows))
        conclusions = set(rows[0][4].strip("{}").split("/"))
        self.assertEqual(archive_report.ROOT_CAUSE_CONCLUSIONS, conclusions)
        self.assertIn("核心用例=通过/失败/未执行", body)
        self.assertIn("未执行或根因链含覆盖缺口时验收完整性必须为不完整", body)

    def test_enterprise_rule_example_uses_structured_coverage_conclusion(self):
        body = ENTERPRISE_RULE.read_text(encoding="utf-8")
        self.assertIn("核心用例=通过/失败/未执行", body)
        self.assertIn("未执行或根因链含覆盖缺口时验收完整性必须为不完整", body)
        example = next(
            line for line in body.splitlines() if line.startswith("| 应验收目标日冻结 SHA |")
        )
        cells = [cell.strip() for cell in example.strip("|").split("|")]
        self.assertEqual("覆盖缺口", cells[4])
        self.assertIn("不是已知产品缺陷", cells[3])

    def test_shipped_templates_ship_plain_summary_first(self):
        heading = f"## {archive_report.PLAIN_SUMMARY_SECTION}"
        for template_name in ("zz-report.md", "report-template.md"):
            with self.subTest(template=template_name):
                body = (TEMPLATES / template_name).read_text(encoding="utf-8")
                lines = body.splitlines()
                self.assertEqual(1, lines.count(heading))
                headings = [line for line in lines if line.startswith("## ")]
                self.assertEqual(heading, headings[0])
                rows = archive_report._section_table_rows(
                    body, archive_report.PLAIN_SUMMARY_SECTION
                )
                fields = [row[0].strip() for row in rows if row]
                self.assertEqual(list(archive_report.PLAIN_SUMMARY_FIELDS), fields)

    def test_standard_and_rule_document_plain_summary(self):
        for source in (STANDARD, ENTERPRISE_RULE):
            with self.subTest(source=source.name):
                body = source.read_text(encoding="utf-8")
                self.assertIn(archive_report.PLAIN_SUMMARY_SECTION, body)
                for answer in archive_report.PLAIN_PRODUCT_ANSWERS:
                    self.assertIn(answer, body)
                self.assertIn(archive_report.PLAIN_NO_DECISION, body)

    def test_missing_plain_summary_is_rejected(self):
        body = report_body("覆盖不足")
        start = body.index(f"## {archive_report.PLAIN_SUMMARY_SECTION}")
        end = body.index("## 结论分层")
        errors = archive_report._daily_conclusion_contract_errors(
            "conditional", body[:start] + body[end:]
        )
        self.assertTrue(any("[说人话]" in error for error in errors))

    def test_script_failure_cannot_be_reported_as_broken_product(self):
        body = report_body("硬门禁失败").replace(
            "| 产品能不能用 | 这次没测出来，不能保证 |",
            "| 产品能不能用 | 有功能坏了，用户点进去会失败 |",
        )
        errors = archive_report._daily_conclusion_contract_errors("fail", body)
        self.assertTrue(any("不得说成产品坏了" in error for error in errors))

    def test_unconfirmed_run_cannot_claim_product_is_fine(self):
        body = report_body("验收链路失败").replace(
            "| 产品能不能用 | 这次没测出来，不能保证 |",
            "| 产品能不能用 | 可以正常使用，走了一遍没发现问题 |",
        )
        errors = archive_report._daily_conclusion_contract_errors("fail", body)
        self.assertTrue(any("必须写「这次没测出来」" in error for error in errors))

    def test_real_product_failure_cannot_be_softened(self):
        body = report_body("产品失败", counts=(0, 1, 0, 0)).replace(
            "| 产品能不能用 | 有功能坏了，用户点进去会失败 |",
            "| 产品能不能用 | 这次没测出来，不能保证 |",
        )
        errors = archive_report._daily_conclusion_contract_errors("fail", body)
        self.assertTrue(any("不能写成这次没测出来" in error for error in errors))

    def test_claiming_finished_while_coverage_is_open_is_rejected(self):
        body = report_body("覆盖不足").replace(
            "| 验收测完了吗 | 没测完，缺 1 项 |",
            "| 验收测完了吗 | 测完了 |",
        )
        errors = archive_report._daily_conclusion_contract_errors("conditional", body)
        self.assertTrue(any("测完了" in error and "矛盾" in error for error in errors))

    def test_unexplained_jargon_is_rejected_but_explained_jargon_passes(self):
        base = report_body("覆盖不足")
        jargon = base.replace(
            "| 验收测完了吗 | 没测完，缺 1 项 |",
            "| 验收测完了吗 | 没测完，缺 1 项，发布门禁没跑完 |",
        )
        self.assertTrue(
            any(
                "未解释的验收行话" in error
                for error in archive_report._daily_conclusion_contract_errors(
                    "conditional", jargon
                )
            )
        )
        explained = base.replace(
            "| 验收测完了吗 | 没测完，缺 1 项 |",
            "| 验收测完了吗 | 没测完，缺 1 项，发布门禁（上线前的自动检查）没跑完 |",
        )
        self.assertEqual(
            [],
            archive_report._daily_conclusion_contract_errors("conditional", explained),
        )

    def test_plain_summary_presence_needs_a_real_heading(self):
        self.assertTrue(
            archive_report._has_plain_summary_section(
                f"# 标题\n\n## {archive_report.PLAIN_SUMMARY_SECTION}\n\n| a | b |\n"
            )
        )
        self.assertFalse(
            archive_report._has_plain_summary_section(
                f"# 标题\n\n## 目标与价值\n\n验证「{archive_report.PLAIN_SUMMARY_SECTION}」首屏不误伤。\n"
            )
        )

    def test_jargon_explanation_tolerates_extra_spacing(self):
        self.assertEqual(
            [], archive_report._plain_summary_jargon_errors("发布门禁  （上线前的自动检查）没跑完")
        )
        self.assertTrue(
            archive_report._plain_summary_jargon_errors("发布门禁没跑完")
        )

    def test_decision_row_must_offer_a_recommendation(self):
        body = report_body("覆盖不足").replace(
            f"| 需要你决定什么 | {archive_report.PLAIN_NO_DECISION} |",
            "| 需要你决定什么 | 录音那条链路还没测 |",
        )
        errors = archive_report._daily_conclusion_contract_errors("conditional", body)
        self.assertTrue(any("必须给出建议" in error for error in errors))

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

    def test_coverage_nature_requires_matching_root_conclusion(self):
        body = report_body("覆盖不足").replace(
            "| 验收冻结 SHA | 当前部署 SHA 已前进 | 预览跟随最新 HEAD | 当前截图不能证明冻结版本 | 覆盖缺口 | 创建冻结预览后复测 |",
            "| 验收冻结 SHA | 当前部署 SHA 已前进 | 预览跟随最新 HEAD | 当前截图不能证明冻结版本 | 通过 | 创建冻结预览后复测 |",
        )
        errors = archive_report._daily_conclusion_contract_errors("conditional", body)
        self.assertTrue(any("根因链结论没有「覆盖缺口」" in error for error in errors))

    def test_root_conclusion_cannot_manufacture_incomplete_fact(self):
        body = report_body("覆盖不足").replace(
            "不完整，1 项无法确认", "完整，全部计划范围均已确认"
        )
        errors = archive_report._daily_conclusion_contract_errors("conditional", body)
        self.assertTrue(
            any("验收完整性和覆盖缺口没有缺口事实" in error for error in errors)
        )

    def test_product_failure_can_use_fail(self):
        body = report_body("产品失败", counts=(0, 1, 0, 0))
        errors = archive_report._daily_conclusion_contract_errors("fail", body)
        self.assertEqual([], errors)

    def test_coverage_only_cannot_be_relabelled_product_failure(self):
        errors = archive_report._daily_conclusion_contract_errors(
            "fail", report_body("产品失败")
        )
        self.assertTrue(any("缺少 P0/P1 产品失败事实" in error for error in errors))
        self.assertTrue(any("必须使用 conditional" in error for error in errors))

    def test_blocking_product_defect_cannot_be_conditional(self):
        body = report_body("覆盖不足", counts=(0, 1, 0, 0))
        errors = archive_report._daily_conclusion_contract_errors("conditional", body)
        self.assertTrue(any("必须使用 fail" in error for error in errors))

    def test_p2_only_defect_can_remain_conditional(self):
        body = report_body("非阻断风险", counts=(0, 0, 1, 0)) + """
## 缺陷清单

| ID | 严重级 | 现象 |
|---|---|---|
| D-1 | P2 | 非阻断体验问题 |
"""
        errors = archive_report._daily_conclusion_contract_errors("conditional", body)
        self.assertEqual([], errors)

    def test_nonblocking_nature_requires_matching_root_conclusion(self):
        body = report_body("非阻断风险", counts=(0, 0, 1, 0)).replace(
            "| 验收冻结 SHA | 当前部署 SHA 已前进 | 预览跟随最新 HEAD | 当前截图不能证明冻结版本 | 非阻断风险 | 创建冻结预览后复测 |",
            "| 验收冻结 SHA | 当前部署 SHA 已前进 | 预览跟随最新 HEAD | 当前截图不能证明冻结版本 | 通过 | 创建冻结预览后复测 |",
        )
        errors = archive_report._daily_conclusion_contract_errors("conditional", body)
        self.assertTrue(any("根因链结论没有「非阻断风险」" in error for error in errors))

    def test_p1_in_severity_vector_cannot_be_conditional(self):
        body = report_body("覆盖不足", counts=(0, 1, 0, 0))
        errors = archive_report._daily_conclusion_contract_errors("conditional", body)
        self.assertTrue(any("必须使用 fail" in error for error in errors))
        self.assertFalse(any("同时声称缺陷为 0" in error for error in errors))

    def test_p2_in_severity_vector_can_remain_conditional(self):
        body = report_body("非阻断风险", counts=(0, 0, 1, 0))
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
        body = report_body("硬门禁失败").replace(
            "| 验收冻结 SHA | 当前部署 SHA 已前进 | 预览跟随最新 HEAD | 当前截图不能证明冻结版本 | 硬门禁失败 | 创建冻结预览后复测 |",
            "| 验收冻结 SHA | 当前部署 SHA 已前进 | 预览跟随最新 HEAD | 当前截图不能证明冻结版本 | 覆盖缺口 | 创建冻结预览后复测 |",
        )
        errors = archive_report._daily_conclusion_contract_errors("fail", body)
        self.assertTrue(any("根因链结论没有「硬门禁失败」" in error for error in errors))

    def test_hard_gate_failure_with_structured_conclusion_can_use_fail(self):
        body = report_body("硬门禁失败")
        errors = archive_report._daily_conclusion_contract_errors("fail", body)
        self.assertEqual([], errors)

    def test_acceptance_chain_failure_requires_chain_fact(self):
        body = report_body("验收链路失败").replace(
            "| 验收冻结 SHA | 当前部署 SHA 已前进 | 预览跟随最新 HEAD | 当前截图不能证明冻结版本 | 验收链路失败 | 创建冻结预览后复测 |",
            "| 验收冻结 SHA | 当前部署 SHA 已前进 | 预览跟随最新 HEAD | 当前截图不能证明冻结版本 | 覆盖缺口 | 创建冻结预览后复测 |",
        )
        errors = archive_report._daily_conclusion_contract_errors("fail", body)
        self.assertTrue(any("根因链结论没有「验收链路失败」" in error for error in errors))

    def test_acceptance_chain_failure_with_structured_conclusion_can_use_fail(self):
        body = report_body("验收链路失败")
        errors = archive_report._daily_conclusion_contract_errors("fail", body)
        self.assertEqual([], errors)

    def test_failure_words_in_narrative_do_not_override_coverage_conclusion(self):
        body = report_body("覆盖不足").replace(
            "当前部署 SHA 已前进 | 预览跟随最新 HEAD | 当前截图不能证明冻结版本",
            "CDS smoke 失败 | 归档失败导致无法取证 | 失败日志仅描述目标版本",
        )
        errors = archive_report._daily_conclusion_contract_errors("conditional", body)
        self.assertEqual([], errors)

    def test_core_failure_is_distinct_from_zero_product_defects(self):
        errors = archive_report._daily_conclusion_contract_errors(
            "fail", report_body("核心用例失败")
        )
        self.assertEqual([], errors)

    def test_structured_core_failure_cannot_be_conditional(self):
        body = report_body("覆盖不足").replace("核心用例=通过", "核心用例=失败")
        errors = archive_report._daily_conclusion_contract_errors("conditional", body)
        self.assertTrue(any("必须使用 fail" in error for error in errors))

    def test_unstructured_core_failure_wording_is_rejected(self):
        body = report_body("覆盖不足").replace("核心用例=通过", "核心用例失败")
        errors = archive_report._daily_conclusion_contract_errors("conditional", body)
        self.assertTrue(any("核心用例=通过/失败/未执行" in error for error in errors))

    def test_root_core_failure_requires_independent_product_quality_fact(self):
        body = report_body("核心用例失败").replace("核心用例=失败", "核心用例=通过")
        errors = archive_report._daily_conclusion_contract_errors("fail", body)
        self.assertTrue(any("核心用例结果不是失败" in error for error in errors))

    def test_invalid_core_case_result_is_rejected(self):
        body = report_body("完整通过").replace("核心用例=通过", "核心用例=部分通过")
        errors = archive_report._daily_conclusion_contract_errors("pass", body)
        self.assertTrue(any("核心用例结果只允许" in error for error in errors))

    def test_unexecuted_core_case_cannot_claim_complete(self):
        body = (
            report_body("非阻断风险", counts=(0, 0, 1, 0))
            .replace("核心用例=通过", "核心用例=未执行")
            .replace("不完整，1 项无法确认", "完整，全部计划范围均已确认")
        )
        errors = archive_report._daily_conclusion_contract_errors("conditional", body)
        self.assertTrue(any("核心用例=未执行时" in error for error in errors))

    def test_unexecuted_core_case_with_incomplete_coverage_can_be_conditional(self):
        body = report_body("覆盖不足").replace("核心用例=通过", "核心用例=未执行")
        errors = archive_report._daily_conclusion_contract_errors("conditional", body)
        self.assertEqual([], errors)

    def test_secondary_root_coverage_gap_cannot_claim_complete_for_any_verdict(self):
        cases = (
            (
                "conditional",
                report_body("非阻断风险", counts=(0, 0, 1, 0))
                .replace("不完整，1 项无法确认", "完整，全部计划范围均已确认"),
            ),
            (
                "fail",
                report_body("产品失败", counts=(0, 1, 0, 0))
                .replace("不完整，1 项无法确认", "完整，全部计划范围均已确认"),
            ),
        )
        secondary_gap = "| 次要浏览器范围 | Safari 未执行 | 环境不可用 | 无法证明兼容性 | 覆盖缺口 | 补环境后复测 |"
        for verdict, body in cases:
            with self.subTest(verdict=verdict):
                errors = archive_report._daily_conclusion_contract_errors(
                    verdict, body.rstrip() + "\n" + secondary_gap + "\n"
                )
                self.assertTrue(any("根因链仍有覆盖缺口" in error for error in errors))

    def test_unknown_root_conclusion_is_rejected(self):
        body = report_body("覆盖不足").replace(
            "| 验收冻结 SHA | 当前部署 SHA 已前进 | 预览跟随最新 HEAD | 当前截图不能证明冻结版本 | 覆盖缺口 | 创建冻结预览后复测 |",
            "| 验收冻结 SHA | 当前部署 SHA 已前进 | 预览跟随最新 HEAD | 当前截图不能证明冻结版本 | 无法确认 | 创建冻结预览后复测 |",
        )
        errors = archive_report._daily_conclusion_contract_errors("conditional", body)
        self.assertTrue(any("当前无效值：无法确认" in error for error in errors))

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

    def test_pass_is_rejected_when_root_chain_records_coverage_gap(self):
        body = report_body("完整通过").replace(
            "| 验收冻结 SHA | 当前部署 SHA 已前进 | 预览跟随最新 HEAD | 当前截图不能证明冻结版本 | 通过 | 创建冻结预览后复测 |",
            "| 验收冻结 SHA | 当前部署 SHA 已前进 | 预览跟随最新 HEAD | 当前截图不能证明冻结版本 | 覆盖缺口 | 创建冻结预览后复测 |",
        )
        errors = archive_report._daily_conclusion_contract_errors("pass", body)
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
            "| 验收冻结 SHA | 当前部署 SHA 已前进 | 预览跟随最新 HEAD | 当前截图不能证明冻结版本 | 覆盖缺口 | 创建冻结预览后复测 |",
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

    def test_reviewer_summary_separates_pass_fail_not_run_and_intervention(self):
        body = """
## 主管验收总览

| 模块 | 真实面包屑 | 冒烟 | 功能 | 视觉 | 最高问题 | 是否需干预 | 查看步骤 | 查看截图 | 查看缺陷 | 关联测试方法 |
|---|---|---|---|---|---|---|---|---|---|---|
| 登录 | 登录 → 首页 → 头像 | 通过 | 通过 | 通过 | 无 | 否 | [步骤](#a) | [截图](#b) | [缺陷](#c) | [方法](#d) |
| 多图 | 首页 → 视觉创作 → 结果 | 通过 | 不通过 | 不通过 | P1 | 是 | [步骤](#e) | [截图](#f) | [缺陷](#g) | [方法](#h) |
| 视频 | 首页 → 视频创作 → 成片 | 通过 | 未执行 | 未执行 | 无 | 需干预 | [步骤](#i) | [截图](#j) | [缺陷](#k) | [方法](#l) |
"""
        summary = archive_report._reviewer_summary(body)
        self.assertIsNotNone(summary)
        self.assertEqual(
            {"pass": 1, "partial": 0, "fail": 1, "not_run": 1, "intervention": 2},
            summary["counts"],
        )

    def test_supervisor_gate_rejects_pass_when_module_budget_is_short(self):
        body = """
验收场景：全面视觉回归

## 主管验收总览

| 模块 | 真实面包屑 | 冒烟 | 功能 | 视觉 | 最高问题 | 是否需干预 | 查看步骤 | 查看截图 | 查看缺陷 | 关联测试方法 |
|---|---|---|---|---|---|---|---|---|---|---|
| 多图视觉创作 | 首页 → 视觉创作 → 生成结果 | 通过 | 通过 | 通过 | 无 | 否 | [步骤](#a) | [截图](#b) | [缺陷](#c) | [方法](#d) |

## 视觉证据预算

| 模块 | 计划截图 | 实际截图 | 入口 | 输入或动作 | 加载 | 结果 | 失败或恢复 | 移动端 | 结论 | 证据 |
|---|---:|---:|---|---|---|---|---|---|---|---|
| 多图视觉创作 | 3 | 2 | 通过 | 通过 | 通过 | 通过 | 通过 | 通过 | 通过 | [证据](#b) |
"""
        manifest = [
            {"name": "01-a", "module": "多图视觉创作"},
            {"name": "02-b", "module": "多图视觉创作"},
        ]
        errors = archive_report._supervisor_report_errors("全面视觉回归", body, manifest)
        self.assertTrue(any("实际 2 < 计划 3" in error for error in errors))

    def test_supervisor_gate_requires_clickable_reviewer_links(self):
        body = """
## 主管验收总览

| 模块 | 真实面包屑 | 冒烟 | 功能 | 视觉 | 最高问题 | 是否需干预 | 查看步骤 | 查看截图 | 查看缺陷 | 关联测试方法 |
|---|---|---|---|---|---|---|---|---|---|---|
| 登录 | 登录 → 首页 → 头像 | 通过 | 通过 | 通过 | 无 | 否 | 见正文 | [截图](#b) | [缺陷](#c) | [方法](#d) |

## 视觉证据预算

| 模块 | 计划截图 | 实际截图 | 入口 | 输入或动作 | 加载 | 结果 | 失败或恢复 | 移动端 | 结论 | 证据 |
|---|---:|---:|---|---|---|---|---|---|---|---|
| 登录 | 1 | 1 | 通过 | 通过 | 不适用 | 通过 | 通过 | 通过 | 通过 | [证据](#b) |
"""
        errors = archive_report._supervisor_report_errors(
            "主管验收", body, [{"name": "01-login", "module": "登录"}]
        )
        self.assertTrue(any("查看步骤" in error and "可点击" in error for error in errors))

    def test_supervisor_gate_accepts_complete_budget_and_manifest(self):
        body = """
## 主管验收总览

| 模块 | 真实面包屑 | 冒烟 | 功能 | 视觉 | 最高问题 | 是否需干预 | 查看步骤 | 查看截图 | 查看缺陷 | 关联测试方法 |
|---|---|---|---|---|---|---|---|---|---|---|
| 登录 | 登录 → 首页 → 头像 | 通过 | 通过 | 通过 | 无 | 否 | [步骤](#a) | [截图](#b) | [缺陷](#c) | [方法](#d) |

## 视觉证据预算

| 模块 | 计划截图 | 实际截图 | 入口 | 输入或动作 | 加载 | 结果 | 失败或恢复 | 移动端 | 结论 | 证据 |
|---|---:|---:|---|---|---|---|---|---|---|---|
| 登录 | 1 | 1 | 通过 | 通过 | 不适用 | 通过 | 通过 | 通过 | 通过 | [证据](#b) |
"""
        errors = archive_report._supervisor_report_errors(
            "主管验收", body, [{"name": "01-login", "module": "登录"}]
        )
        self.assertEqual([], errors)

    def test_supervisor_gate_accepts_new_collected_and_qualified_coverage(self):
        body = """
## 主管验收总览

| 模块 | 真实面包屑 | 冒烟 | 功能 | 视觉 | 最高问题 | 是否需干预 | 查看步骤 | 查看截图 | 查看缺陷 | 关联测试方法 |
|---|---|---|---|---|---|---|---|---|---|---|
| 登录 | 登录 → 首页 → 头像 | 通过 | 通过 | 未执行 | P2 | 是 | [步骤](#a) | [截图](#b) | [缺陷](#c) | [方法](#d) |

## 模块覆盖

| 模块 | 视觉结论 | 真实面包屑 | 采集文件 | 合格证据 | 关键状态 | 缺口 | 查看全部截图 | 测试方法 |
|---|---|---|---:|---:|---:|---|---|---|
| 登录 | 未执行 | 登录 → 首页 → 头像 | 1 | 0/2 | 0/2 | 缺逐项元数据 | [查看](#visual-ledger-login) | [查看](#visual-method-login) |
"""
        errors = archive_report._supervisor_report_errors(
            "主管验收", body, [{"name": "01-login", "module": "登录"}]
        )
        self.assertEqual([], errors)

    def test_supervisor_gate_accepts_auditable_evidence_header(self):
        body = """
## 主管验收总览

| 模块 | 真实面包屑 | 冒烟 | 功能 | 视觉 | 最高问题 | 是否需干预 | 查看步骤 | 查看截图 | 查看缺陷 | 关联测试方法 |
|---|---|---|---|---|---|---|---|---|---|---|
| 登录 | 登录 → 首页 → 头像 | 通过 | 通过 | 通过 | 无 | 否 | [步骤](#a) | [截图](#b) | [缺陷](#c) | [方法](#d) |

## 模块覆盖

| 模块 | 视觉结论 | 真实面包屑 | 采集文件 | 可审核证据 | 关键状态 | 缺口 | 查看全部截图 | 测试方法 |
|---|---|---|---:|---:|---:|---|---|---|
| 登录 | 通过 | 登录 → 首页 → 头像 | 1 | 1/1 | 1/1 | 无 | [查看](#visual-ledger-login) | [查看](#visual-method-login) |
"""
        manifest = [{
            "name": "01-login",
            "module": "登录",
            "primaryState": "登录",
            "coverageStates": ["登录"],
            "testType": "视觉",
            "status": "通过",
            "theme": "dark",
            "viewportClass": "desktop",
            "methodAnchor": "#visual-method-login",
            "breadcrumb": "登录 → 首页 → 头像",
        }]
        errors = archive_report._supervisor_report_errors("主管验收", body, manifest)
        self.assertEqual([], errors)

    def test_supervisor_gate_rejects_false_qualified_count(self):
        body = """
## 主管验收总览

| 模块 | 真实面包屑 | 冒烟 | 功能 | 视觉 | 最高问题 | 是否需干预 | 查看步骤 | 查看截图 | 查看缺陷 | 关联测试方法 |
|---|---|---|---|---|---|---|---|---|---|---|
| 登录 | 登录 → 首页 → 头像 | 通过 | 通过 | 通过 | 无 | 否 | [步骤](#a) | [截图](#b) | [缺陷](#c) | [方法](#d) |

## 模块覆盖

| 模块 | 视觉结论 | 真实面包屑 | 采集文件 | 合格证据 | 关键状态 | 缺口 | 查看全部截图 | 测试方法 |
|---|---|---|---:|---:|---:|---|---|---|
| 登录 | 通过 | 登录 → 首页 → 头像 | 1 | 1/1 | 1/1 | 无 | [查看](#visual-ledger-login) | [查看](#visual-method-login) |
"""
        errors = archive_report._supervisor_report_errors(
            "主管验收", body, [{"name": "01-login", "module": "登录"}]
        )
        self.assertTrue(any("报告可审核 1，manifest 可审核 0" in error for error in errors))

    def test_failure_report_can_archive_explicit_runtime_failure_evidence(self):
        errors = archive_report._warning_evidence_errors("fail", {
            "name": "01-real-failure",
            "warnings": ["自动捕获(P0,network): HTTP 500"],
            "failureEvidence": True,
            "failureReason": "保存动作真实返回 500，页面显示失败恢复提示",
        })
        self.assertEqual([], errors)

    def test_pass_report_cannot_hide_runtime_failure_as_evidence(self):
        errors = archive_report._warning_evidence_errors("pass", {
            "name": "01-real-failure",
            "warnings": ["自动捕获(P0,network): HTTP 500"],
            "failureEvidence": True,
            "failureReason": "保存动作真实返回 500，页面显示失败恢复提示",
        })
        self.assertTrue(any("pass 报告不能包含失败证据" in error for error in errors))

    def test_failure_evidence_requires_a_specific_reason(self):
        errors = archive_report._warning_evidence_errors("fail", {
            "name": "01-real-failure",
            "warnings": ["HTTP 500"],
            "failureEvidence": True,
            "failureReason": "失败",
        })
        self.assertTrue(any("failureReason" in error for error in errors))


class InteractiveReportLinkContractTests(unittest.TestCase):
    manifest = [{
        "name": "01-proof",
        "caption": "请求记录：业务请求与轮询调用已经分层展示",
        "warnings": [],
    }]
    figure_srcs = {"fig-01-proof": "https://assets.example.test/01-proof.png"}

    @staticmethod
    def body(gap_heading: str) -> str:
        return f"""
## 缺陷清单

无。

## {gap_heading}

| 编号 | 未覆盖项 | 风险级别 |
|---|---|---|
| GAP-1 | 真实租户数据链路 | 非阻断风险 |

## 步骤 1

<span id="fig-01-proof" class="figure-anchor"></span>

![请求记录](https://assets.example.test/01-proof.png)
"""

    def build(self, gap_heading: str) -> str:
        return archive_report.build_interactive_html(
            "Commit验收 · 报告内部链接",
            "conditional",
            self.body(gap_heading),
            self.manifest,
            figure_srcs=self.figure_srcs,
        )

    def test_gap_card_uses_coverage_gap_heading_when_total_ledger_is_absent(self):
        content = self.build("覆盖缺口")
        self.assertIn('href="#覆盖缺口">查看完整缺口账本</a>', content)
        self.assertNotIn('href="#总缺口账本">查看完整缺口账本</a>', content)
        self.assertEqual([], archive_report._interactive_evidence_errors(content, self.manifest))

    def test_gap_card_uses_total_ledger_heading_when_present(self):
        content = self.build("总缺口账本")
        self.assertIn('href="#总缺口账本">查看完整缺口账本</a>', content)
        self.assertEqual([], archive_report._interactive_evidence_errors(content, self.manifest))

    def test_failed_report_uses_numbered_canonical_defect_heading(self):
        content = archive_report.build_interactive_html(
            "Commit验收 · 编号缺陷章节",
            "fail",
            """
## 8. 缺陷清单（P0-P3）

| ID | 严重级 | 现象 |
|---|---|---|
| D-1 | P2 | 请求计数错误 |
""",
            [],
            figure_srcs={},
        )
        self.assertIn('href="#8-缺陷清单-p0-p3">查看正文缺陷清单</a>', content)
        self.assertEqual([], archive_report._interactive_evidence_errors(content, []))

    def test_any_unresolved_internal_link_is_rejected(self):
        content = self.build("覆盖缺口").replace(
            'href="#覆盖缺口">查看完整缺口账本</a>',
            'href="#不存在的章节">查看完整缺口账本</a>',
            1,
        )
        errors = archive_report._interactive_evidence_errors(content, self.manifest)
        self.assertTrue(any("无法唯一解析的内部链接" in error for error in errors))

    def test_explicit_method_anchor_survives_markdown_rendering(self):
        body = (
            self.body("覆盖缺口")
            + "\n\n| 测试方法 |\n"
              "|---|\n"
              "| [查看](#method-core-001) |\n\n"
              '<a id="method-core-001"></a>\n'
              "### 首页与静态资源\n"
        )
        rendered = archive_report.build_interactive_html(
            "Commit验收 · 测试方法锚点",
            "conditional",
            body,
            self.manifest,
            figure_srcs=self.figure_srcs,
        )
        self.assertIn('href="#method-core-001"', rendered)
        self.assertIn('<span id="method-core-001"></span>', rendered)
        self.assertEqual([], archive_report._interactive_evidence_errors(rendered, self.manifest))


if __name__ == "__main__":
    unittest.main()
