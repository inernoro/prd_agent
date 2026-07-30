import importlib.util
import pathlib
import unittest


SCRIPT = pathlib.Path(__file__).with_name("archive_report.py")
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
    return f"""
## 结论分层

| 结论维度 | 结果 |
|---|---|
| 产品质量 | 未发现可复现产品缺陷，缺陷 0 个 |
| 验收完整性 | 不完整，1 项无法确认 |
| 综合结论 | {overall} |
| 发布建议 | main 可继续，未发布分支暂不作质量承诺 |
| 判定性质 | {nature} |

## 根因链条

| 目标要求 | 观察事实 | 系统原因 | 证据影响 | 结论 | 关闭动作 |
|---|---|---|---|---|---|
| 验收冻结 SHA | 当前部署 SHA 已前进 | 预览跟随最新 HEAD | 当前截图不能证明冻结版本 | 无法确认 | 创建冻结预览后复测 |
"""


class DailyVerdictContractTests(unittest.TestCase):
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

    def test_missing_root_cause_chain_is_rejected(self):
        body = report_body("覆盖不足").split("## 根因链条", 1)[0]
        errors = archive_report._daily_conclusion_contract_errors("conditional", body)
        self.assertTrue(any("根因链条" in error for error in errors))

    def test_pass_does_not_require_root_cause_chain(self):
        body = report_body("完整通过").split("## 根因链条", 1)[0]
        errors = archive_report._daily_conclusion_contract_errors("pass", body)
        self.assertEqual([], errors)


if __name__ == "__main__":
    unittest.main()
