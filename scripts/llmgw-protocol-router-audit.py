#!/usr/bin/env python3
"""Static LLM Gateway protocol-router target audit.

This script is a read-only progress reporter for the target architecture:
multi-protocol ingress -> Gateway Request IR -> appCaller registry ->
GW router/model pools -> provider adapter/upstream, with console and runtime
evidence gates.

It does not call production, MAP, Gateway, or model providers.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]


def _read(rel: str) -> str:
    path = ROOT / rel
    return path.read_text(encoding="utf-8") if path.exists() else ""


def _contains_all(text: str, needles: list[str]) -> tuple[bool, str]:
    missing = [item for item in needles if item not in text]
    return not missing, "missing: " + ", ".join(missing) if missing else "ok"


def _check(group: str, name: str, ok: bool, detail: str, evidence: list[str]) -> dict[str, Any]:
    return {
        "group": group,
        "name": name,
        "ok": bool(ok),
        "detail": detail,
        "evidence": evidence,
    }


def _write_json(path: str, payload: dict[str, Any]) -> None:
    if not path:
        return
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _write_markdown(path: str, payload: dict[str, Any]) -> None:
    if not path:
        return
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)

    def cell(value: object) -> str:
        return str(value).replace("|", "\\|")

    lines = [
        "# LLM Gateway Protocol Router Target Audit",
        "",
        f"- generatedAt: `{cell(payload['generatedAt'])}`",
        f"- verdict: `{cell(payload['verdict'])}`",
        f"- scope: `{cell(payload['scope'])}`",
        f"- targetComplete: `{cell(payload['targetComplete'])}`",
        f"- runtimeEvidenceComplete: `{cell(payload['runtimeEvidenceComplete'])}`",
        f"- passed: `{payload['passedChecks']}/{payload['totalChecks']}`",
        f"- staticEvidencePercent: `{payload['staticEvidencePercent']}`",
        f"- progressPercent: `{cell(payload.get('progressPercent'))}`",
        f"- progressSemantics: `{cell(payload['progressSemantics'])}`",
        "",
        "## Checks",
        "",
        "| Group | Check | Status | Detail |",
        "|---|---|---|---|",
    ]
    for check in payload["checks"]:
        status = "pass" if check["ok"] else "fail"
        lines.append(
            f"| {cell(check['group'])} | {cell(check['name'])} | {status} | {cell(check['detail'])} |"
        )
    lines.extend(["", "## Failed Evidence", ""])
    failures = [item for item in payload["checks"] if not item["ok"]]
    if failures:
        for item in failures:
            lines.append(f"- `{cell(item['group'])}/{cell(item['name'])}`: {cell(item['detail'])}")
            for evidence in item.get("evidence") or []:
                lines.append(f"  - `{cell(evidence)}`")
    else:
        lines.append("- none")

    lines.extend(["", "## Remaining Runtime Gates", ""])
    for gate in payload.get("remainingRuntimeGates") or []:
        lines.append(f"- `{cell(gate['name'])}`: {cell(gate['evidence'])}")

    out.write_text("\n".join(lines) + "\n", encoding="utf-8")


def build_report() -> dict[str, Any]:
    target_doc = _read("doc/design.platform.llm-gateway.physical-isolation.md")
    brief = _read("assets/prototypes/llmgw-architecture-drawing-brief.md")
    html = _read("assets/prototypes/llmgw-architecture-map.html")
    request = _read("prd-api/src/PrdAgent.Core/LlmGateway/GatewayRequest.cs")
    endpoints = _read("llmgw/serving/GatewayHttpEndpoints.cs")
    gateway_core = _read("prd-api/src/PrdAgent.Infrastructure/LlmGateway/LlmGateway.cs")
    resolver = _read("prd-api/src/PrdAgent.Infrastructure/LlmGateway/ModelResolver.cs")
    console = _read("llmgw/console-api/Program.cs")
    console_app = _read("llmgw/web/src/App.tsx")
    console_layout = _read("llmgw/web/src/components/ConsoleLayout.tsx")
    logs_view = _read("llmgw/web/src/components/LogsView.tsx")
    details_drawer = _read("llmgw/web/src/components/GenerationDetailsDrawer.tsx")
    overview_page = _read("llmgw/web/src/pages/OverviewPage.tsx")
    app_callers_page = _read("llmgw/web/src/pages/AppCallersPage.tsx")
    pools_page = _read("llmgw/web/src/pages/ModelPoolsPage.tsx")
    models_page = _read("llmgw/web/src/pages/ModelsPage.tsx")
    platforms_page = _read("llmgw/web/src/pages/PlatformsPage.tsx")
    exchanges_page = _read("llmgw/web/src/pages/ExchangesPage.tsx")
    audits_page = _read("llmgw/web/src/pages/AuditsPage.tsx")
    protocol_canary = _read("scripts/llmgw-protocol-canary.py")
    config_authority_backup = _read("scripts/llmgw-config-authority-backup.sh")
    config_authority_apply = _read("scripts/llmgw-config-authority-apply.py")
    compose = _read("docker-compose.yml")
    cds_compose = _read("cds-compose.yml")
    protocol_router_changelog = _read("changelogs/2026-07-09_llmgw-protocol-router.md")
    assembled_changelog = _read("CHANGELOG.md")

    checks: list[dict[str, Any]] = []

    ok, detail = _contains_all(
        target_doc,
        [
            "MAP `prd-api`",
            "`llmgw-serve`",
            "appCaller",
            "模型池",
            "OpenAI",
            "Anthropic",
            "Gemini",
            "配置权威",
        ],
    )
    checks.append(_check(
        "ssot",
        "physical_isolation_design_declares_protocol_chain",
        ok,
        detail,
        ["doc/design.platform.llm-gateway.physical-isolation.md"],
    ))

    ok, detail = _contains_all(
        brief + "\n" + html,
        [
            "模型池最终归属是 GW",
            "GW ingress adapter",
            "GW Request IR",
            "appCaller registry",
            "GW model pools",
            "provider adapter",
            "MAP keeps business protocol and lifecycle.",
            "MAP does not own model routing in target state.",
        ],
    )
    no_old_claim = "模型池仍负责选模型" not in brief and "模型池仍负责选模型" not in html
    checks.append(_check(
        "ssot",
        "architecture_assets_describe_target_not_current_state",
        ok and no_old_claim,
        detail if ok and no_old_claim else f"{detail}; oldClaimPresent={not no_old_claim}",
        [
            "assets/prototypes/llmgw-architecture-drawing-brief.md",
            "assets/prototypes/llmgw-architecture-map.html",
        ],
    ))

    ok, detail = _contains_all(
        request,
        [
            "public sealed class GatewayIngressRequest",
            "public required string RequestId { get; init; }",
            "public string SourceSystem { get; init; } = \"external\";",
            "public required string IngressProtocol { get; init; }",
            "public required string AppCallerCode { get; init; }",
            "public required string RequestType { get; init; }",
            "public string ModelPolicy { get; init; } = \"auto\";",
            "public string? ModelPoolId { get; init; }",
            "public string ParameterPolicy { get; init; } = \"default-drop\";",
            "public List<string> DroppedParameters { get; init; } = new();",
        ],
    )
    checks.append(_check(
        "gateway-ir",
        "gateway_request_ir_has_target_fields",
        ok,
        detail,
        ["prd-api/src/PrdAgent.Core/LlmGateway/GatewayRequest.cs"],
    ))

    ok, detail = _contains_all(
        endpoints,
        [
            "app.MapPost(\"/v1/responses\"",
            "app.MapPost(\"/v1/chat/completions\"",
            "app.MapPost(\"/v1/images/generations\"",
            "app.MapPost(\"/v1/images/edits\"",
            "app.MapPost(\"/v1/messages\"",
            "app.MapPost(\"/v1beta/models/{model}:generateContent\"",
            "app.MapPost(\"/gemini/v1beta/models/{model}:streamGenerateContent\"",
            "IngressProtocol = \"openai-compatible\"",
            "IngressProtocol = \"claude-compatible\"",
            "IngressProtocol = \"gemini-compatible\"",
            "IngressProtocol = body.Context?.IngressProtocol ?? \"gw-native\"",
            "ResolveCompatModelPolicy",
            "ResolveCompatModelPoolId",
            # 兼容入口不再接受客户端自带的 pin：它绕过白名单授权按内部 id 直取上游，
            # 而池退场之后，池成员检查这道调用方边界跟着没了（2026-09-16）。
            # 判据从「取值并透传」改成「当场拒绝」，函数名里也写清了是拒绝。
            "RejectClientSuppliedPinnedTarget",
            "pinned_target_not_allowed",
            "X-Gateway-Model-Policy",
            "X-Gateway-Model-Pool-Id",
            "X-Gateway-Pinned-Platform-Id",
            "X-Gateway-Pinned-Model-Id",
            "NormalizeModelPolicy",
            "ModelPoolId = modelPoolId",
        ],
    )
    checks.append(_check(
        "ingress",
        "four_protocol_families_enter_serving_and_set_ingress_protocol",
        ok,
        detail,
        ["llmgw/serving/GatewayHttpEndpoints.cs"],
    ))

    governance_count = endpoints.count("RecordAndCheckAppCallerGovernanceAsync")
    ok, detail = _contains_all(
        endpoints + "\n" + gateway_core,
        [
            "private static async Task<bool> RecordDiscoveredAppCallerAsync",
            "GetCollection<GatewayAppCallerRecord>(\"llmgw_app_callers\")",
            "SetOnInsert(x => x.Status, \"discovered\")",
            "Set(x => x.SourceSystem",
            "Set(x => x.IngressProtocol",
            "Set(x => x.Title",
            "Inc(x => x.TotalSeen, 1)",
            "IsUpsert = true",
            "Collation = GatewayAppCallerIdentity.Collation",
            "RecordAndCheckAppCallerGovernanceAsync",
            "ReserveMonthlyBudgetsAsync",
            "CheckTenantRateLimitAsync",
            "GatewayBudgetCoordinator",
            "TENANT_RATE_LIMITED",
            "TENANT_MONTHLY_BUDGET_EXCEEDED",
            "APP_CALLER_RATE_LIMITED",
            "APP_CALLER_MONTHLY_BUDGET_EXCEEDED",
            "TryRejectStrictDroppedParametersAsync",
            "appCallerCode 必须使用 {app-key}.{feature}::{model-type} 格式",
            "separatorIndex != code.LastIndexOf",
        ],
    )
    no_static_runtime_gate = "appCallerCode 未注册" not in gateway_core
    checks.append(_check(
        "appcaller-registry",
        "ingress_records_discovered_appcallers_and_applies_governance",
        ok and governance_count >= 9 and no_static_runtime_gate,
        f"{detail}; governanceCallCount={governance_count}; noStaticRuntimeGate={no_static_runtime_gate}",
        [
            "llmgw/serving/GatewayHttpEndpoints.cs",
            "prd-api/src/PrdAgent.Infrastructure/LlmGateway/LlmGateway.cs",
        ],
    ))

    ok, detail = _contains_all(
        resolver + "\n" + compose + "\n" + cds_compose,
        [
            # 2026-09-15 断流后删掉了模型池那一整套分支，所以这里不再要求池相关的符号存在。
            # 仍然要守的是同一件事：GW 配置是权威，MAP 只是兼容退路，且退路能被开关关掉。
            "DisableMapConfigFallbackForRegisteredAppCallers",
            "DisableMapConfigFallbackForActiveAppCallers",
            "TryGetGatewayAppCallerStatusAsync",
            "TryResolveLogicalModelAsync",
            "TryResolveDefaultLogicalModelAsync",
            "allowMapFallback: !gatewayConfigRequired",
            "LLMGW_DISABLE_MAP_CONFIG_FALLBACK_FOR_REGISTERED_APP_CALLERS",
            "LLMGW_DISABLE_MAP_CONFIG_FALLBACK_FOR_ACTIVE_APP_CALLERS",
            "LlmGateway__DisableMapConfigFallbackForRegisteredAppCallers",
            "LlmGateway__DisableMapConfigFallbackForActiveAppCallers",
        ],
    )
    checks.append(_check(
        "router",
        "resolver_prioritizes_gw_registry_and_has_map_fallback_exit_gate",
        ok,
        detail,
        [
            "prd-api/src/PrdAgent.Infrastructure/LlmGateway/ModelResolver.cs",
            "docker-compose.yml",
            "cds-compose.yml",
        ],
    ))

    ok, detail = _contains_all(
        console,
        [
            "app.MapGet(\"/gw/config-authority/report\"",
            "app.MapGet(\"/gw/runtime-gates\"",
            "app.MapGet(\"/gw/protocol-coverage\"",
            "RuntimeGateLinks",
            "static RuntimeGateLink Link",
            "Links = RuntimeGateLinks",
            "/audits?targetType=llmgw_config_authority",
            "app.MapPost(\"/gw/config-authority/bulk-claim\"",
            "app.MapPost(\"/gw/config-authority/bind-active-app-callers\"",
            "app.MapGet(\"/gw/app-callers\"",
            "app.MapPut(\"/gw/app-callers/{id}\"",
            "app.MapPost(\"/gw/app-callers/bulk-governance\"",
            "app.MapGet(\"/gw/audits\"",
            "llmgw_operation_audits",
            "appcaller_policy_drift",
            "HasObservedFieldDrift",
            "/gw/app-callers?drift=any",
            "appcaller_runtime_coverage",
            "missingRuntimeCoverageAppCallers",
            "coveredAppCallerCodes",
            "gateway_pool_member_readiness",
            # 这条 gate 随模型池退场改成非 blocking，指路不再指向已删的 /pools 页面；
            # 它原本守的「线路可用性」已并入 active_appcaller_pool_binding，
            # 那条现在用 FindUnnamedCatcherAsync（与运行时两层判据逐层对齐）。
            "FindUnnamedCatcherAsync",
            "线路可用性已并入 active_appcaller_pool_binding",
            "active_appcaller_map_fallback_exit",
            "activeAppCallerMapFallbackExitReady",
            "disableMapFallbackForActiveAppCallers",
            "LLMGW_DISABLE_MAP_CONFIG_FALLBACK_FOR_ACTIVE_APP_CALLERS",
            "TargetIngressProtocols",
            "NormalizeIngressProtocol",
            "ProtocolCoverageData",
            "DroppedParameterRequests",
            "var runtimeCommit = NormalizeCommitFilter(gitCommit)",
            "Builders<BsonDocument>.Filter.Eq(\"ReleaseCommit\", runtimeCommit)",
            "current_commit_http_transport",
            "protocol_runtime_coverage",
            "httpTransportLogs",
            "nonHttpTransportLogs",
            "missingIngressProtocols",
            "/gw/protocol-coverage?releaseCommit=",
            "Builders<BsonDocument>.Filter.Ne(\"GatewayTransport\", \"http\")",
            "dropped_parameter_runtime_evidence",
            "Builders<BsonDocument>.Filter.Exists(\"DroppedParameters.0\", true)",
            "/gw/logs?releaseCommit=",
            "gateway_key_integrity",
            "GwApiKeyCrypto.HasDedicatedPrimarySecret(config)",
            "/gw/key-health total=",
        ],
    )
    checks.append(_check(
        "config-authority",
        "console_exposes_gw_owned_config_authority_and_appcaller_governance",
        ok,
        detail,
        ["llmgw/console-api/Program.cs"],
    ))

    # 发布后的四协议 canary 由 exec_dep.sh 直接调用；配置权威的迁移工具保持「先备份、再应用」
    # 两个独立脚本，由操作者按需执行。这里只守工具本身在、且四类协议入口都被 canary 覆盖。
    ok, detail = _contains_all(
        protocol_canary,
        [
            "LLM Gateway four-protocol runtime canary",
            "--execute",
            "gw-native",
            "openai-compatible",
            "claude-compatible",
            "gemini-compatible",
        ],
    )
    config_tools_present = bool(config_authority_backup.strip()) and bool(config_authority_apply.strip())
    checks.append(_check(
        "release",
        "protocol_canary_covers_four_ingress_protocols_and_config_tools_exist",
        ok and config_tools_present,
        detail if config_tools_present else f"{detail}; configAuthorityToolsPresent=false",
        [
            "scripts/llmgw-protocol-canary.py",
            "scripts/llmgw-config-authority-backup.sh",
            "scripts/llmgw-config-authority-apply.py",
        ],
    ))

    console_bundle = "\n".join([
        console_app,
        console_layout,
        logs_view,
        details_drawer,
        overview_page,
        app_callers_page,
        pools_page,
        models_page,
        platforms_page,
        exchanges_page,
        audits_page,
    ])
    ok, detail = _contains_all(
        console_bundle,
        [
            "path=\"/logs\"",
            "path=\"/app-callers\"",
            "path=\"/pools\"",
            "path=\"/models\"",
            "path=\"/platforms\"",
            "path=\"/exchanges\"",
            "path=\"/audits\"",
            "routerTrace",
            "providerAttempts",
            "droppedParameters",
            "initialQueryValue('releaseCommit')",
            "releaseCommit: filterReleaseCommit.trim() || undefined",
            "runtimeGateActionLinks",
            "item.links && item.links.length > 0 ? item.links : runtimeGateActionLinks",
            "/logs${releaseQuery}",
            "/app-callers?status=active",
            "/audits?targetType=llmgw_config_authority",
            "configAuthority",
            "RuntimeGatePanel",
            "ProtocolCoveragePanel",
            "getProtocolCoverage({ releaseCommit: protocolReleaseCommit, sinceHours: 24 })",
            "case 'protocol_runtime_coverage':",
            "bulkUpdateGatewayAppCallers",
        ],
    )
    checks.append(_check(
        "console",
        "console_surfaces_activity_router_appcallers_pools_models_platforms_exchanges_audits",
        ok,
        detail,
        ["llmgw/web/src/**"],
    ))

    ok, detail = _contains_all(
        protocol_router_changelog + "\n" + assembled_changelog,
        [
            "四类协议入口",
            "appCaller 被动注册",
        ],
    )
    checks.append(_check(
        "reporting",
        "readiness_and_changelog_capture_protocol_router_progress",
        ok,
        detail,
        [
            "changelogs/2026-07-09_llmgw-protocol-router.md",
            "CHANGELOG.md",
        ],
    ))

    passed = sum(1 for item in checks if item["ok"])
    total = len(checks)
    static_percent = round((passed / total) * 100, 2) if total else 0
    remaining_runtime_gates = [
        {
            "name": "production_config_authority_execute",
            "evidence": "scripts/llmgw-config-authority-backup.sh non-dry-run backup, then scripts/llmgw-config-authority-apply.py execute, and production /gw/config-authority/report status=ready",
        },
        {
            "name": "active_appcaller_map_fallback_exit",
            "evidence": "production /gw/config-authority/report shows activeAppCallerMapFallbackReady=true, then LlmGateway:DisableMapConfigFallbackForActiveAppCallers enabled and verified",
        },
        {
            "name": "post_deploy_gateway_verification",
            "evidence": "exec_dep.sh post-deploy serving probe, gw-smoke and four-protocol canary pass for the released commit",
        },
    ]
    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "scope": "static-code-and-document-evidence",
        "targetComplete": False,
        "runtimeEvidenceComplete": False,
        "verdict": "pass" if passed == total else "fail",
        "totalChecks": total,
        "passedChecks": passed,
        "staticEvidencePercent": static_percent,
        "progressPercent": None,
        "progressSemantics": "staticEvidencePercent covers code/doc evidence only; runtime gates and post-deploy verification prove target completion.",
        "remainingRuntimeGates": remaining_runtime_gates,
        "checks": checks,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="LLM Gateway protocol-router target static audit")
    parser.add_argument("--json-out", default="", help="Write machine-readable audit report")
    parser.add_argument("--report-md", default="", help="Write markdown audit report")
    args = parser.parse_args()

    report = build_report()
    _write_json(args.json_out, report)
    _write_markdown(args.report_md, report)

    if report["verdict"] != "pass":
        print("LLM Gateway protocol router audit: FAIL", file=sys.stderr)
        for item in report["checks"]:
            if not item["ok"]:
                print(f"- {item['group']}/{item['name']}: {item['detail']}", file=sys.stderr)
        return 1

    print(
        "LLM Gateway protocol router audit: PASS "
        f"checks={report['passedChecks']}/{report['totalChecks']} "
        f"staticEvidence={report['staticEvidencePercent']}% "
        "targetComplete=false"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
