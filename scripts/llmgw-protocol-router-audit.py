#!/usr/bin/env python3
"""Static LLM Gateway protocol-router target audit.

This script is a read-only progress reporter for the target architecture:
multi-protocol ingress -> Gateway Request IR -> appCaller registry ->
GW router/model pools -> provider adapter/upstream, with console and rollout
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
        f"- passed: `{payload['passedChecks']}/{payload['totalChecks']}`",
        f"- staticEvidencePercent: `{payload['staticEvidencePercent']}`",
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
    target_doc = _read("doc/plan.platform.llm-gateway-protocol-router.md")
    full_cutover_doc = _read("doc/plan.llm-gateway.full-cutover.md")
    brief = _read("assets/prototypes/llmgw-architecture-drawing-brief.md")
    html = _read("assets/prototypes/llmgw-architecture-map.html")
    request = _read("prd-api/src/PrdAgent.Infrastructure/LlmGateway/GatewayRequest.cs")
    endpoints = _read("prd-api/src/PrdAgent.LlmGateway/GatewayHttpEndpoints.cs")
    resolver = _read("prd-api/src/PrdAgent.Infrastructure/LlmGateway/ModelResolver.cs")
    console = _read("prd-llmgw/Program.cs")
    console_app = _read("prd-llmgw-web/src/App.tsx")
    console_layout = _read("prd-llmgw-web/src/components/ConsoleLayout.tsx")
    logs_view = _read("prd-llmgw-web/src/components/LogsView.tsx")
    details_drawer = _read("prd-llmgw-web/src/components/GenerationDetailsDrawer.tsx")
    overview_page = _read("prd-llmgw-web/src/pages/OverviewPage.tsx")
    app_callers_page = _read("prd-llmgw-web/src/pages/AppCallersPage.tsx")
    shadow_page = _read("prd-llmgw-web/src/pages/ShadowPage.tsx")
    pools_page = _read("prd-llmgw-web/src/pages/ModelPoolsPage.tsx")
    models_page = _read("prd-llmgw-web/src/pages/ModelsPage.tsx")
    platforms_page = _read("prd-llmgw-web/src/pages/PlatformsPage.tsx")
    exchanges_page = _read("prd-llmgw-web/src/pages/ExchangesPage.tsx")
    audits_page = _read("prd-llmgw-web/src/pages/AuditsPage.tsx")
    prod_stage = _read("scripts/llmgw-prod-stage.sh")
    rollout_ledger = _read("scripts/llmgw-rollout-ledger.py")
    compose = _read("docker-compose.yml")
    cds_compose = _read("cds-compose.yml")
    readiness = _read("scripts/llmgw-readiness-audit.py")
    changelog = _read("changelogs/2026-07-09_llmgw-protocol-router.md")

    checks: list[dict[str, Any]] = []

    ok, detail = _contains_all(
        target_doc,
        [
            "MAP / 外部系统",
            "GW ingress adapter",
            "GW Request IR",
            "appCaller registry",
            "GW router",
            "GW model pools",
            "provider adapter",
            "OpenAI-compatible",
            "Claude-compatible",
            "Gemini-compatible",
            "config-authority",
        ],
    )
    checks.append(_check(
        "ssot",
        "target_protocol_router_plan_declares_goal_chain",
        ok,
        detail,
        ["doc/plan.platform.llm-gateway-protocol-router.md"],
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
        ["prd-api/src/PrdAgent.Infrastructure/LlmGateway/GatewayRequest.cs"],
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
            "ResolveCompatPinnedTarget",
            "X-Gateway-Model-Policy",
            "X-Gateway-Model-Pool-Id",
            "X-Gateway-Pinned-Platform-Id",
            "X-Gateway-Pinned-Model-Id",
            "NormalizeModelPolicy",
            "ModelPoolId = modelPoolId",
            "PinnedPlatformId = pinnedPlatformId",
            "PinnedModelId = pinnedModelId",
        ],
    )
    checks.append(_check(
        "ingress",
        "four_protocol_families_enter_serving_and_set_ingress_protocol",
        ok,
        detail,
        ["prd-api/src/PrdAgent.LlmGateway/GatewayHttpEndpoints.cs"],
    ))

    governance_count = endpoints.count("RecordAndCheckAppCallerGovernanceAsync")
    ok, detail = _contains_all(
        endpoints,
        [
            "private static async Task RecordDiscoveredAppCallerAsync",
            "GetCollection<GatewayAppCallerRecord>(\"llmgw_app_callers\")",
            "SetOnInsert(x => x.Status, \"discovered\")",
            "Set(x => x.SourceSystem",
            "Set(x => x.IngressProtocol",
            "Set(x => x.Title",
            "Inc(x => x.TotalSeen, 1)",
            "new UpdateOptions { IsUpsert = true }",
            "RecordAndCheckAppCallerGovernanceAsync",
            "CheckAppCallerMonthlyBudgetAsync",
            "APP_CALLER_RATE_LIMITED",
            "APP_CALLER_MONTHLY_BUDGET_EXCEEDED",
            "TryRejectStrictDroppedParametersAsync",
        ],
    )
    checks.append(_check(
        "appcaller-registry",
        "ingress_records_discovered_appcallers_and_applies_governance",
        ok and governance_count >= 9,
        f"{detail}; governanceCallCount={governance_count}",
        ["prd-api/src/PrdAgent.LlmGateway/GatewayHttpEndpoints.cs"],
    ))

    ok, detail = _contains_all(
        resolver + "\n" + prod_stage + "\n" + compose + "\n" + cds_compose,
        [
            "使用 GW appCaller active 模型池",
            "DisableMapConfigFallbackForActiveAppCallers",
            "GW active appCaller 禁止 MAP fallback",
            "TryGetActiveGatewayRegistryGroupsAsync",
            "FindGatewayOwnedOrMapModelPoolAsync",
            "FindGatewayOwnedExchangeAsync",
            "allowMapFallback: !activeGatewayAppCallerRequiresGwConfig",
            "LLMGW_DISABLE_MAP_CONFIG_FALLBACK_FOR_ACTIVE_APP_CALLERS",
            "LlmGateway__DisableMapConfigFallbackForActiveAppCallers",
            "disableMapConfigFallbackForActiveAppCallers",
            "disable_map_fallback_default=true",
        ],
    )
    checks.append(_check(
        "router",
        "resolver_prioritizes_gw_registry_and_has_map_fallback_exit_gate",
        ok,
        detail,
        [
            "prd-api/src/PrdAgent.Infrastructure/LlmGateway/ModelResolver.cs",
            "scripts/llmgw-prod-stage.sh",
            "docker-compose.yml",
            "cds-compose.yml",
        ],
    ))

    ok, detail = _contains_all(
        console,
        [
            "app.MapGet(\"/gw/config-authority/report\"",
            "app.MapGet(\"/gw/runtime-gates\"",
            "app.MapPost(\"/gw/config-authority/bulk-claim\"",
            "app.MapPost(\"/gw/config-authority/bind-active-app-callers\"",
            "app.MapGet(\"/gw/app-callers\"",
            "app.MapPut(\"/gw/app-callers/{id}\"",
            "app.MapPost(\"/gw/app-callers/bulk-governance\"",
            "app.MapPost(\"/gw/pools\"",
            "app.MapPost(\"/gw/pools/bulk-claim\"",
            "app.MapGet(\"/gw/audits\"",
            "llmgw_operation_audits",
            "ReadyForHttpFull",
            "config_authority_rollout_ledger",
            "appcaller_policy_drift",
            "HasObservedFieldDrift",
            "/gw/app-callers?drift=any",
            "appcaller_runtime_coverage",
            "missingRuntimeCoverageAppCallers",
            "coveredAppCallerCodes",
            "gateway_pool_member_readiness",
            "HasUsablePoolMember",
            "IsResolvablePoolMember",
            "/gw/pools activeBoundPools=",
            "active_appcaller_map_fallback_exit",
            "activeAppCallerMapFallbackExitReady",
            "disableMapFallbackForActiveAppCallers",
            "LLMGW_DISABLE_MAP_CONFIG_FALLBACK_FOR_ACTIVE_APP_CALLERS",
            "ReadLatestHttpFullRolloutLedgerEvidence",
            "ReadLatestConfigAuthorityRolloutLedgerEvidence",
            "LlmGateway:RolloutLedgerPath",
            "LLMGW_ROLLOUT_LEDGER",
            "same-commit",
            "externalBackupJson",
            "var runtimeCommit = NormalizeCommitFilter(gitCommit)",
            "Builders<BsonDocument>.Filter.Eq(\"ReleaseCommit\", runtimeCommit)",
            "current_commit_http_transport",
            "httpTransportLogs",
            "nonHttpTransportLogs",
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
        ["prd-llmgw/Program.cs"],
    ))

    ok, detail = _contains_all(
        prod_stage + "\n" + rollout_ledger + "\n" + full_cutover_doc,
        [
            "config-authority",
            "scripts/llmgw-config-authority-backup.sh",
            "LLMGW_CONFIG_AUTHORITY_BACKUP_DRY_RUN=0",
            "scripts/llmgw-config-authority-apply.py",
            "--external-backup-json",
            "_require_external_backup",
            "_require_config_authority_apply",
            "protocol-router-audit.json",
            "--protocol-router-audit-json",
            "_require_protocol_router_audit",
            "protocolRouterAuditJson",
            "targetComplete must remain false until runtime gates pass",
            "activeAppCallerMapFallbackReady=true",
        ],
    )
    backup_before_apply = (
        prod_stage.find("scripts/llmgw-config-authority-backup.sh") >= 0
        and prod_stage.find("python3 scripts/llmgw-config-authority-apply.py") >= 0
        and prod_stage.find("scripts/llmgw-config-authority-backup.sh")
        < prod_stage.find("python3 scripts/llmgw-config-authority-apply.py")
    )
    checks.append(_check(
        "rollout",
        "config_authority_stage_is_backup_first_and_ledger_gated",
        ok and backup_before_apply,
        detail if backup_before_apply else f"{detail}; backupBeforeApply=false",
        [
            "scripts/llmgw-prod-stage.sh",
            "scripts/llmgw-rollout-ledger.py",
            "doc/plan.llm-gateway.full-cutover.md",
        ],
    ))

    console_bundle = "\n".join([
        console_app,
        console_layout,
        logs_view,
        details_drawer,
        overview_page,
        app_callers_page,
        shadow_page,
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
            "searchParams.get('releaseCommit')",
            "getShadowComparisons({",
            "runtimeGateActionLinks",
            "/logs${releaseQuery}",
            "/shadow${releaseQuery}",
            "/app-callers?status=active",
            "/audits?targetType=llmgw_config_authority",
            "configAuthority",
            "RuntimeGatePanel",
            "bulkUpdateGatewayAppCallers",
        ],
    )
    checks.append(_check(
        "console",
        "console_surfaces_activity_router_appcallers_pools_models_platforms_exchanges_audits",
        ok,
        detail,
        ["prd-llmgw-web/src/**"],
    ))

    ok, detail = _contains_all(
        readiness + "\n" + changelog,
        [
            "config_authority_stage_backup_is_local_auditable_and_safe",
            "prod_stage_runner_sequences_shadow_canary_http_and_rollback",
            "scripts/llmgw-config-authority-backup.sh",
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
            "scripts/llmgw-readiness-audit.py",
            "changelogs/2026-07-09_llmgw-protocol-router.md",
        ],
    ))

    passed = sum(1 for item in checks if item["ok"])
    total = len(checks)
    static_percent = round((passed / total) * 100, 2) if total else 0
    remaining_runtime_gates = [
        {
            "name": "production_config_authority_execute",
            "evidence": "rollout ledger success for config-authority with non-dry-run backup evidence and configAuthority status=ready",
        },
        {
            "name": "active_appcaller_map_fallback_exit",
            "evidence": "production /gw/config-authority/report shows activeAppCallerMapFallbackReady=true, then LlmGateway:DisableMapConfigFallbackForActiveAppCallers enabled and verified",
        },
        {
            "name": "full_http_rollout_acceptance",
            "evidence": "http-full rollout ledger success with release gate, serving probe, smoke, shadow coverage, and configAuthority.ok=true",
        },
        {
            "name": "legacy_cleanup_after_stability",
            "evidence": "inproc/legacy retained through stability window; deletion only after rollback window is no longer required",
        },
    ]
    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "scope": "static-code-and-document-evidence",
        "targetComplete": False,
        "verdict": "pass" if passed == total else "fail",
        "totalChecks": total,
        "passedChecks": passed,
        "staticEvidencePercent": static_percent,
        "progressPercent": static_percent,
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
