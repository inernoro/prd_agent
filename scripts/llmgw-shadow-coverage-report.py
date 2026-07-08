#!/usr/bin/env python3
"""LLM Gateway shadow coverage report.

This is a read-only evidence collector for S5/S6 rollout. It queries
/gw/v1/shadow-comparisons and renders explicit global, kind, appCaller, and
appCaller:kind coverage cells without printing the gateway key.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone


def _default_base() -> str:
    raw = os.environ.get("GW_BASE", "").strip().rstrip("/")
    if raw:
        return raw
    try:
        proc = subprocess.run(
            ["python3", ".claude/skills/cds/cli/cdscli.py", "--human", "preview-url"],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        root = next((line.strip() for line in proc.stdout.splitlines() if line.startswith("http")), "")
        if root:
            return root.rstrip("/") + "/gw/v1"
    except Exception:
        return ""
    return ""


def _split_csv(raw: str) -> list[str]:
    out: list[str] = []
    for item in raw.replace(";", ",").split(","):
        value = item.strip()
        if value:
            out.append(value)
    return out


def _request(base: str, key: str, query: dict[str, str]) -> tuple[int, str]:
    encoded = urllib.parse.urlencode(query)
    suffix = f"?{encoded}" if encoded else ""
    req = urllib.request.Request(base + "/shadow-comparisons" + suffix, method="GET")
    req.add_header("User-Agent", "Mozilla/5.0 llmgw-shadow-coverage/1.0")
    req.add_header("X-Gateway-Key", key)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")
    except Exception as exc:
        return 0, f"ERR {exc}"


def _normalize_commit(value: str | None) -> str:
    raw = (value or "").strip()
    if raw.lower().startswith("sha-"):
        raw = raw[4:]
    return raw.lower()


def _parse_kind_requirement(raw: str, default_min: int) -> tuple[str, int]:
    value = raw.strip()
    if not value:
        raise ValueError("空 kind requirement")
    if ":" not in value:
        return value, default_min
    kind, min_raw = value.rsplit(":", 1)
    if not kind.strip() or not min_raw.strip().isdigit():
        raise ValueError(f"kind requirement 格式应为 kind 或 kind:min: {raw}")
    return kind.strip(), int(min_raw.strip())


def _parse_app_kind_requirement(raw: str) -> tuple[str, str, int]:
    parts = raw.strip().rsplit(":", 2)
    if len(parts) != 3 or not parts[0].strip() or not parts[1].strip() or not parts[2].strip().isdigit():
        raise ValueError(f"app kind requirement 格式应为 appCallerCode:kind:min: {raw}")
    return parts[0].strip(), parts[1].strip(), int(parts[2].strip())


def _upsert_cell_spec(
    specs: list[dict],
    index: dict[tuple[str | None, str | None], dict],
    *,
    app: str | None,
    kind: str | None,
    required_total: int,
    source: str,
) -> None:
    key = (app, kind)
    existing = index.get(key)
    if existing is not None:
        existing["requiredTotal"] = max(int(existing["requiredTotal"]), required_total)
        sources = existing.setdefault("sources", [])
        if source not in sources:
            sources.append(source)
        return

    spec = {
        "appCallerCode": app,
        "kind": kind,
        "requiredTotal": required_total,
        "sources": [source],
    }
    specs.append(spec)
    index[key] = spec


def _payload_from_raw(raw: str) -> dict:
    return json.loads(raw)


def _summary_from_payload(payload: dict) -> dict:
    summary = payload.get("summary") or payload.get("Summary") or {}
    return {
        "total": int(summary.get("total") or summary.get("Total") or 0),
        "allMatch": int(summary.get("allMatch") or summary.get("AllMatch") or 0),
        "critical": int(summary.get("critical") or summary.get("Critical") or 0),
        "httpFail": int(summary.get("httpFail") or summary.get("HttpFail") or 0),
        "firstComparedAt": summary.get("firstComparedAt") or summary.get("FirstComparedAt"),
        "lastComparedAt": summary.get("lastComparedAt") or summary.get("LastComparedAt"),
        "coverageHours": float(summary.get("coverageHours") or summary.get("CoverageHours") or 0),
    }


def _failure_samples_from_payload(payload: dict) -> list[dict]:
    samples = payload.get("failureRecent") or payload.get("FailureRecent") or []
    if not isinstance(samples, list):
        return []

    out: list[dict] = []
    for item in samples:
        if not isinstance(item, dict):
            continue
        inproc = item.get("inproc") or item.get("Inproc") or {}
        http = item.get("http") or item.get("Http") or {}
        if not isinstance(inproc, dict):
            inproc = {}
        if not isinstance(http, dict):
            http = {}
        out.append({
            "id": item.get("id") or item.get("_id") or item.get("Id"),
            "comparedAt": item.get("comparedAt") or item.get("ComparedAt"),
            "releaseCommit": item.get("releaseCommit") or item.get("ReleaseCommit"),
            "appCallerCode": item.get("appCallerCode") or item.get("AppCallerCode"),
            "kind": item.get("kind") or item.get("Kind"),
            "modelType": item.get("modelType") or item.get("ModelType"),
            "httpOk": item.get("httpOk") if "httpOk" in item else item.get("HttpOk"),
            "hasCritical": item.get("hasCritical") if "hasCritical" in item else item.get("HasCritical"),
            "httpError": item.get("httpError") or item.get("HttpError"),
            "inprocModel": inproc.get("actualModel") or inproc.get("ActualModel"),
            "httpModel": http.get("actualModel") or http.get("ActualModel"),
            "inprocGroup": inproc.get("modelGroupId") or inproc.get("ModelGroupId"),
            "httpGroup": http.get("modelGroupId") or http.get("ModelGroupId"),
            "inprocPlatformType": inproc.get("platformType") or inproc.get("PlatformType"),
            "httpPlatformType": http.get("platformType") or http.get("PlatformType"),
            "inprocResolutionType": inproc.get("resolutionType") or inproc.get("ResolutionType"),
            "httpResolutionType": http.get("resolutionType") or http.get("ResolutionType"),
            "inprocFallback": inproc.get("isFallback") if "isFallback" in inproc else inproc.get("IsFallback"),
            "httpFallback": http.get("isFallback") if "isFallback" in http else http.get("IsFallback"),
        })
    return out


def _cell(
    base: str,
    key: str,
    app: str | None,
    kind: str | None,
    min_total: int,
    since_hours: float,
    min_coverage_hours: float,
    release_commit: str,
    failure_sample_limit: int,
) -> dict:
    query: dict[str, str] = {}
    label = "global"
    if app:
        query["appCallerCode"] = app
        label = app
    if kind:
        query["kind"] = kind
        label = f"{label}/{kind}"
    if since_hours > 0:
        query["sinceHours"] = f"{since_hours:g}"
    if failure_sample_limit >= 0:
        query["failureLimit"] = str(failure_sample_limit)
    normalized_release_commit = _normalize_commit(release_commit)
    if normalized_release_commit:
        query["releaseCommit"] = normalized_release_commit

    code, raw = _request(base, key, query)
    result = {
        "label": label,
        "appCallerCode": app,
        "kind": kind,
        "requiredTotal": min_total,
        "sinceHours": since_hours,
        "minCoverageHours": min_coverage_hours,
        "releaseCommit": normalized_release_commit,
        "httpStatus": code,
        "total": 0,
        "allMatch": 0,
        "critical": 0,
        "httpFail": 0,
        "firstComparedAt": None,
        "lastComparedAt": None,
        "coverageHours": 0.0,
        "ok": False,
        "failures": [],
        "failureSamples": [],
        "sources": [],
    }
    if code != 200:
        result["failures"].append(f"HTTP {code}: {raw[:200]}")
        return result

    try:
        payload = _payload_from_raw(raw)
        result.update(_summary_from_payload(payload))
        result["failureSamples"] = _failure_samples_from_payload(payload)
    except Exception as exc:
        result["failures"].append(f"invalid JSON: {exc}")
        return result

    if result["total"] < min_total:
        result["failures"].append(f"样本不足 total={result['total']}, required={min_total}")
    if min_coverage_hours > 0 and result["coverageHours"] < min_coverage_hours:
        result["failures"].append(
            f"覆盖时长不足 coverageHours={result['coverageHours']:.2f}, required={min_coverage_hours:g}"
        )
    if result["critical"] != 0:
        result["failures"].append(f"critical mismatch 未清零: {result['critical']}")
    if result["httpFail"] != 0:
        result["failures"].append(f"httpFail 未清零: {result['httpFail']}")
    result["ok"] = not result["failures"]
    return result


def _write_json(path: str, report: dict) -> None:
    if not path:
        return
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2, sort_keys=True)
        fh.write("\n")


def _write_markdown(path: str, report: dict) -> None:
    if not path:
        return
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)

    def cell(value: object) -> str:
        return str(value).replace("|", "\\|")

    with open(path, "w", encoding="utf-8") as fh:
        fh.write("# LLM Gateway Shadow Coverage Report\n\n")
        fh.write(f"- generatedAt: `{cell(report['generatedAt'])}`\n")
        fh.write(f"- verdict: `{cell(report['verdict'])}`\n")
        fh.write(f"- base: `{cell(report['base'])}`\n")
        fh.write(f"- sinceHours: `{cell(report['sinceHours'])}`\n")
        fh.write(f"- releaseCommit: `{cell(report.get('releaseCommit') or '')}`\n")
        fh.write(f"- minPerCell: `{cell(report['minPerCell'])}`\n\n")
        fh.write(f"- minCoverageHours: `{cell(report['minCoverageHours'])}`\n\n")
        fh.write("| label | required | minCoverageHours | total | coverageHours | allMatch | critical | httpFail | status | failures |\n")
        fh.write("|---|---:|---:|---:|---:|---:|---:|---:|---|---|\n")
        for item in report["cells"]:
            status = "pass" if item.get("ok") else "fail"
            failures = "; ".join(item.get("failures") or [])
            fh.write(
                f"| {cell(item.get('label'))} | {cell(item.get('requiredTotal'))} | "
                f"{cell(item.get('minCoverageHours'))} | "
                f"{cell(item.get('total'))} | {cell(round(float(item.get('coverageHours') or 0), 2))} | "
                f"{cell(item.get('allMatch'))} | "
                f"{cell(item.get('critical'))} | {cell(item.get('httpFail'))} | "
                f"{status} | {cell(failures)} |\n"
            )

        samples: list[tuple[str, dict]] = []
        seen: set[str] = set()
        for item in report["cells"]:
            for sample in item.get("failureSamples") or []:
                key = str(sample.get("id") or json.dumps(sample, sort_keys=True, ensure_ascii=False))
                if key in seen:
                    continue
                seen.add(key)
                samples.append((str(item.get("label") or ""), sample))

        if samples:
            fh.write("\n## Failure Samples\n\n")
            fh.write("| cell | comparedAt | appCaller | kind | httpOk | critical | inprocModel | httpModel | inprocGroup | httpGroup | platform | resolution | fallback | httpError |\n")
            fh.write("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n")
            for label, sample in samples:
                error = str(sample.get("httpError") or "")
                if len(error) > 180:
                    error = error[:177] + "..."
                platform = sample.get("httpPlatformType") or sample.get("inprocPlatformType") or ""
                resolution = sample.get("httpResolutionType") or sample.get("inprocResolutionType") or ""
                fallback = sample.get("httpFallback")
                if fallback is None:
                    fallback = sample.get("inprocFallback")
                fh.write(
                    f"| {cell(label)} | {cell(sample.get('comparedAt') or '')} | "
                    f"{cell(sample.get('appCallerCode') or '')} | {cell(sample.get('kind') or '')} | "
                    f"{cell(sample.get('httpOk'))} | {cell(sample.get('hasCritical'))} | "
                    f"{cell(sample.get('inprocModel') or '')} | {cell(sample.get('httpModel') or '')} | "
                    f"{cell(sample.get('inprocGroup') or '')} | {cell(sample.get('httpGroup') or '')} | "
                    f"{cell(platform)} | {cell(resolution)} | {cell(fallback)} | {cell(error)} |\n"
                )


def main() -> int:
    parser = argparse.ArgumentParser(description="LLM Gateway shadow coverage matrix report")
    parser.add_argument("--base", default=_default_base(), help="serving base URL, e.g. https://host/gw/v1")
    parser.add_argument("--key", default=os.environ.get("GW_KEY", ""), help="X-Gateway-Key")
    parser.add_argument("--app-caller", action="append", default=[], help="appCallerCode aggregate cell to include; repeatable")
    parser.add_argument("--kind", action="append", default=[], help="shadow kind aggregate cell to include; repeatable, default send+stream")
    parser.add_argument("--require-kind", action="append", default=[],
                        help="required shadow Kind aggregate cell, format kind or kind:min; repeatable")
    parser.add_argument("--require-app-kind", action="append", default=[],
                        help="required appCallerCode + Kind cell, format appCallerCode:kind:min; repeatable")
    parser.add_argument("--skip-global-cells", action="store_true",
                        help="Only check explicitly requested appCaller/kind cells; useful for scoped non-video gates.")
    parser.add_argument("--min-per-cell", type=int, default=int(os.environ.get("LLMGW_GATE_MIN_PER_APP", "30")))
    parser.add_argument("--since-hours", type=float, default=float(os.environ.get("LLMGW_GATE_SHADOW_SINCE_HOURS", "24")))
    parser.add_argument("--min-coverage-hours", type=float, default=float(os.environ.get("LLMGW_GATE_MIN_COVERAGE_HOURS", "0")))
    parser.add_argument("--release-commit", default=os.environ.get("LLMGW_SHADOW_COVERAGE_RELEASE_COMMIT", os.environ.get("GIT_COMMIT", "")),
                        help="可选：只统计指定 MAP/API commit 产生的 shadow 样本")
    parser.add_argument("--failure-sample-limit", type=int, default=int(os.environ.get("LLMGW_SHADOW_COVERAGE_FAILURE_SAMPLE_LIMIT", "10")),
                        help="每个 cell 附带的最近失败样本数；设为 0 可关闭")
    parser.add_argument("--json-out", default=os.environ.get("LLMGW_SHADOW_COVERAGE_JSON_OUT", ""))
    parser.add_argument("--report-md", default=os.environ.get("LLMGW_SHADOW_COVERAGE_REPORT_MD", ""))
    parser.add_argument("--print-json", action="store_true")
    args = parser.parse_args()

    base = (args.base or "").strip().rstrip("/")
    key = args.key.strip()
    app_callers = list(dict.fromkeys(args.app_caller + _split_csv(os.environ.get("LLMGW_HTTP_APP_CALLER_ALLOWLIST", ""))))
    kinds = list(dict.fromkeys(args.kind or ["send", "stream"]))

    report = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "verdict": "fail",
        "base": base,
        "sinceHours": max(0, args.since_hours),
        "releaseCommit": _normalize_commit(args.release_commit),
        "minPerCell": args.min_per_cell,
        "minCoverageHours": max(0, args.min_coverage_hours),
        "appCallers": app_callers,
        "kinds": kinds,
        "failureSampleLimit": max(0, args.failure_sample_limit),
        "requiredKinds": args.require_kind,
        "requiredAppKinds": args.require_app_kind,
        "cells": [],
        "failures": [],
    }

    if not base:
        report["failures"].append("missing --base/GW_BASE")
    if not key:
        report["failures"].append("missing --key/GW_KEY")

    if not report["failures"]:
        min_coverage_hours = max(0, args.min_coverage_hours)
        failure_sample_limit = report["failureSampleLimit"]
        specs: list[dict] = []
        spec_index: dict[tuple[str | None, str | None], dict] = {}
        if not args.skip_global_cells:
            _upsert_cell_spec(specs, spec_index, app=None, kind=None, required_total=args.min_per_cell, source="global")
            for kind in kinds:
                _upsert_cell_spec(specs, spec_index, app=None, kind=kind, required_total=args.min_per_cell, source="kind")
        for app in app_callers:
            _upsert_cell_spec(specs, spec_index, app=app, kind=None, required_total=args.min_per_cell, source="appCaller")
        for raw in args.require_kind:
            try:
                kind, min_total = _parse_kind_requirement(raw, args.min_per_cell)
            except ValueError as exc:
                report["failures"].append(str(exc))
                continue
            _upsert_cell_spec(specs, spec_index, app=None, kind=kind, required_total=min_total, source="requireKind")
        for raw in args.require_app_kind:
            try:
                app, kind, min_total = _parse_app_kind_requirement(raw)
            except ValueError as exc:
                report["failures"].append(str(exc))
                continue
            _upsert_cell_spec(specs, spec_index, app=app, kind=kind, required_total=min_total, source="requireAppKind")

        for spec in specs:
            item = _cell(
                base,
                key,
                spec["appCallerCode"],
                spec["kind"],
                int(spec["requiredTotal"]),
                max(0, args.since_hours),
                min_coverage_hours,
                args.release_commit,
                failure_sample_limit,
            )
            item["sources"] = spec["sources"]
            report["cells"].append(item)
        for item in report["cells"]:
            for failure in item.get("failures") or []:
                report["failures"].append(f"{item['label']}: {failure}")

    report["verdict"] = "fail" if report["failures"] else "pass"
    _write_json(args.json_out, report)
    _write_markdown(args.report_md, report)
    if args.print_json:
        print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))

    print(f"LLM Gateway shadow coverage: {report['verdict'].upper()}")
    print(f"- cells={len(report['cells'])}")
    print(f"- failures={len(report['failures'])}")
    return 1 if report["failures"] else 0


if __name__ == "__main__":
    sys.exit(main())
