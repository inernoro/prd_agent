#!/usr/bin/env python3
"""route-self-test 失败归因的守卫。

背景（2026-07-30）：生产发布连续两次死在 `gateway_route_self_test` 的 401 上，而预检
只输出 `"ok": false` 和一个裸状态码。操作者据此无法区分「网关坏了」和「预检的凭据跟
运行态对不上」，于是把时间花在重试和调超时上——真正的根因是 `.env` 的
LLMGW_SERVE_KEY 已轮换、持 key 容器却从未重建。

本测试钉住三件事，缺一都会让下一个人重走一遍那两个小时：
  1. 401/403 必须归因到「凭据与运行态不一致」，而不是含糊的「网关不可用」；
  2. 提示里必须点破「预检在部署之前运行，重试同一条 run 不会自愈」这个死锁；
  3. 不同失败形态（不可达 / 协议缺失 / 用例失败）不能塌成同一句话。

同时保留反向断言：成功用例不得携带归因字段，避免把「一切正常」也渲染成疑似故障。
"""

import json
import importlib.util
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PREFLIGHT = ROOT / "scripts" / "llmgw-prod-preflight.py"


def _load_preflight_module():
    # 文件名带连字符，不能直接 import，按路径加载。
    spec = importlib.util.spec_from_file_location("llmgw_prod_preflight", PREFLIGHT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


preflight = _load_preflight_module()


def _result(status, payload=None, ok=True):
    return {"ok": ok, "status": status, "payload": payload or {}}


PASSING_PAYLOAD = {
    "Status": "ok",
    "Mode": "dry-run",
    "UpstreamCalled": False,
    "Total": 4,
    "Passed": 4,
    "Cases": [
        {"IngressProtocol": "gw-native"},
        {"IngressProtocol": "openai-compatible"},
        {"IngressProtocol": "claude-compatible"},
        {"IngressProtocol": "gemini-compatible"},
    ],
}


class RouteSelfTestDiagnosisTests(unittest.TestCase):
    def _detail(self, result, key_name="LLMGW_GATE_KEY"):
        check = preflight._gateway_route_self_test_result(result, key_name)
        return check, json.loads(check["detail"])

    def test_passing_check_carries_no_diagnosis(self) -> None:
        """反向断言：正常放行时不许出现归因字段，否则等于天天喊狼来了。"""
        check, detail = self._detail(_result(200, PASSING_PAYLOAD))
        self.assertTrue(check["ok"])
        self.assertNotIn("likelyCause", detail)
        self.assertNotIn("nextAction", detail)

    def test_401_blames_credential_drift_not_gateway_outage(self) -> None:
        check, detail = self._detail(_result(401, {}, ok=False))
        self.assertFalse(check["ok"])
        cause = detail["likelyCause"]
        # 必须点名真正的根因链：key 轮换 -> 容器未重建。
        self.assertIn("LLMGW_SERVE_KEY", cause)
        self.assertIn("重建", cause)
        # 必须说明网关本身可能是健康的，避免误导去重启网关。
        self.assertIn("健康", cause)

    def test_401_next_action_breaks_the_retry_deadlock(self) -> None:
        """预检在部署之前跑，重试同一条 run 永远不会自愈——这句必须在。"""
        _, detail = self._detail(_result(401, {}, ok=False))
        action = detail["nextAction"]
        self.assertIn("force-recreate", action)
        self.assertIn("部署之前", action)
        self.assertIn("重试", action)
        # 重建非 gateway 容器后必须 reload，否则公网 502（本次真实次生故障）。
        self.assertIn("reload", action)

    def test_403_shares_the_credential_diagnosis(self) -> None:
        _, detail = self._detail(_result(403, {}, ok=False))
        self.assertIn("LLMGW_SERVE_KEY", detail["likelyCause"])

    def test_unreachable_gateway_is_distinct_from_credential_drift(self) -> None:
        for status in (0, None, 502, 503):
            with self.subTest(status=status):
                _, detail = self._detail(_result(status, {}, ok=False))
                self.assertNotIn("LLMGW_SERVE_KEY", detail["likelyCause"])
                self.assertIn("就绪", detail["likelyCause"] + detail["nextAction"])

    def test_missing_protocol_points_at_version_skew(self) -> None:
        payload = dict(PASSING_PAYLOAD)
        payload["Total"] = 3
        payload["Passed"] = 3
        payload["Cases"] = [
            {"IngressProtocol": "gw-native"},
            {"IngressProtocol": "openai-compatible"},
            {"IngressProtocol": "claude-compatible"},
        ]
        _, detail = self._detail(_result(200, payload))
        self.assertIn("gemini-compatible", detail["likelyCause"])
        self.assertIn("版本", detail["likelyCause"])
        self.assertNotIn("LLMGW_SERVE_KEY", detail["likelyCause"])

    def test_failing_cases_are_not_reported_as_credential_problem(self) -> None:
        payload = dict(PASSING_PAYLOAD)
        payload["Passed"] = 2
        _, detail = self._detail(_result(200, payload))
        self.assertIn("2/", detail["likelyCause"].replace("passed=", ""))
        self.assertIn("不是凭据问题", detail["likelyCause"])

    def test_every_failure_shape_yields_both_fields(self) -> None:
        """任何失败形态都必须同时给出原因和恢复动作，不许只报错不给出路。"""
        shapes = [
            _result(401, {}, ok=False),
            _result(0, {}, ok=False),
            _result(500, {}, ok=False),
            _result(200, {"Status": "degraded", "Mode": "dry-run"}),
        ]
        for shape in shapes:
            with self.subTest(status=shape["status"]):
                check, detail = self._detail(shape)
                self.assertFalse(check["ok"])
                self.assertTrue(detail["likelyCause"].strip())
                self.assertTrue(detail["nextAction"].strip())


if __name__ == "__main__":
    unittest.main(verbosity=2)
