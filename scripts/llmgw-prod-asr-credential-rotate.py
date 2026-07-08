#!/usr/bin/env python3
"""Safely rotate the production ASR ModelExchange credential through MAP API.

The script never prints the new key. It uses ExchangeController so encryption
stays inside the application. Dry-run reports the target exchange and inferred
auth scheme without writing data.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _join(base: str, path: str) -> str:
    return base.rstrip("/") + "/" + path.lstrip("/")


def _request_json(method: str, url: str, body: dict[str, Any] | None = None, headers: dict[str, str] | None = None, timeout: int = 60) -> dict[str, Any]:
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Accept", "application/json")
    req.add_header("User-Agent", "llmgw-prod-asr-credential-rotate/1.0")
    if body is not None:
        req.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read(2_000_000).decode("utf-8", "replace")
            status = resp.status
    except urllib.error.HTTPError as exc:
        raw = exc.read(2_000_000).decode("utf-8", "replace")
        status = exc.code
    try:
        payload = json.loads(raw) if raw else {}
    except Exception:
        payload = {"raw": raw[:2000]}
    return {"status": status, "payload": payload, "raw": raw[:4000]}


def _api_data(result: dict[str, Any], context: str) -> Any:
    payload = result.get("payload")
    if not isinstance(payload, dict) or payload.get("success") is not True:
        raise RuntimeError(f"{context} failed: status={result.get('status')} body={json.dumps(payload, ensure_ascii=False)[:600]}")
    return payload.get("data")


def _login(base: str, username: str, password: str, timeout: int) -> str:
    result = _request_json(
        "POST",
        _join(base, "/api/v1/auth/login"),
        {"username": username, "password": password, "clientType": "admin"},
        timeout=timeout,
    )
    data = _api_data(result, "login")
    token = (data or {}).get("accessToken") or (data or {}).get("token")
    if not token:
        raise RuntimeError("login succeeded but token is missing")
    return str(token)


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _items(data: Any) -> list[dict[str, Any]]:
    if isinstance(data, dict) and isinstance(data.get("items"), list):
        return [x for x in data["items"] if isinstance(x, dict)]
    if isinstance(data, list):
        return [x for x in data if isinstance(x, dict)]
    return []


def _models(exchange: dict[str, Any]) -> list[dict[str, Any]]:
    values = exchange.get("models") or exchange.get("Models") or []
    return [x for x in values if isinstance(x, dict)]


def _find_exchange(exchanges: list[dict[str, Any]], exchange_id: str, model_id: str) -> dict[str, Any]:
    if exchange_id:
        for exchange in exchanges:
            if str(exchange.get("id") or exchange.get("Id") or "") == exchange_id:
                return exchange
        raise RuntimeError(f"exchange not found: {exchange_id}")

    candidates: list[dict[str, Any]] = []
    for exchange in exchanges:
        transformer = str(exchange.get("transformerType") or exchange.get("TransformerType") or "")
        model_alias = str(exchange.get("modelAlias") or exchange.get("ModelAlias") or "")
        aliases = exchange.get("modelAliases") or exchange.get("ModelAliases") or []
        model_ids = [str(m.get("modelId") or m.get("ModelId") or "") for m in _models(exchange)]
        if transformer in {"doubao-asr", "doubao-asr-stream"} and (model_alias == model_id or model_id in aliases or model_id in model_ids):
            candidates.append(exchange)
    if len(candidates) != 1:
        raise RuntimeError(f"expected exactly one Doubao ASR exchange for model={model_id}, found {len(candidates)}")
    return candidates[0]


def _infer_auth_scheme(raw_key: str, requested: str) -> str:
    if requested.strip():
        return requested.strip()
    return "DoubaoAsr" if "|" in raw_key else "XApiKey"


def _shape(raw_key: str) -> dict[str, Any]:
    return {
        "length": len(raw_key),
        "containsPipe": "|" in raw_key,
        "hasWhitespace": any(ch.isspace() for ch in raw_key),
        "looksUuidOnly": len(raw_key) == 36 and raw_key.count("-") == 4,
    }


def _write_json(path: str, report: dict[str, Any]) -> None:
    if not path:
        return
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Rotate production ASR exchange credential through MAP API")
    parser.add_argument("--api-base", default=os.environ.get("PRD_AGENT_BASE", "http://127.0.0.1:5500"))
    parser.add_argument("--exchange-id", default=os.environ.get("LLMGW_ASR_EXCHANGE_ID", ""))
    parser.add_argument("--model-id", default=os.environ.get("LLMGW_ASR_MODEL_ID", "doubao-asr-bigmodel"))
    parser.add_argument("--target-auth-scheme", default=os.environ.get("LLMGW_ASR_TARGET_AUTH_SCHEME", ""))
    parser.add_argument("--new-key-env", default="LLMGW_ASR_NEW_KEY")
    parser.add_argument("--admin-token", default=os.environ.get("MAP_ADMIN_TOKEN", ""))
    parser.add_argument("--root-username", default=os.environ.get("ROOT_ACCESS_USERNAME", "root"))
    parser.add_argument("--root-password", default=os.environ.get("ROOT_ACCESS_PASSWORD", ""))
    parser.add_argument("--dry-run", action="store_true", default=os.environ.get("LLMGW_ASR_CREDENTIAL_ROTATE_DRY_RUN", "1").lower() not in {"0", "false"})
    parser.add_argument("--timeout", type=int, default=60)
    parser.add_argument("--json-out", default="")
    parser.add_argument("--print-json", action="store_true")
    args = parser.parse_args()

    new_key = os.environ.get(args.new_key_env, "")
    report: dict[str, Any] = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "apiBase": args.api_base.rstrip("/"),
        "dryRun": bool(args.dry_run),
        "exchangeId": args.exchange_id or None,
        "modelId": args.model_id,
        "newKeyEnv": args.new_key_env,
        "newKeyShape": _shape(new_key) if new_key else None,
        "verdict": "fail",
        "failures": [],
    }

    if not new_key.strip():
        report["failures"].append(f"missing {args.new_key_env}")
        _write_json(args.json_out, report)
        print(f"LLM Gateway ASR credential rotate: FAIL missing {args.new_key_env}")
        return 2
    if _shape(new_key)["hasWhitespace"]:
        report["failures"].append("new ASR key contains whitespace")
        _write_json(args.json_out, report)
        print("LLM Gateway ASR credential rotate: FAIL new key contains whitespace")
        return 2

    try:
        token = args.admin_token.strip() or _login(args.api_base, args.root_username, args.root_password, args.timeout)
        list_result = _request_json("GET", _join(args.api_base, "/api/mds/exchanges"), headers=_bearer(token), timeout=args.timeout)
        exchanges = _items(_api_data(list_result, "list exchanges"))
        exchange = _find_exchange(exchanges, args.exchange_id.strip(), args.model_id.strip())
        exchange_id = str(exchange.get("id") or exchange.get("Id") or "")
        auth_scheme = _infer_auth_scheme(new_key, args.target_auth_scheme)
        report.update({
            "exchangeId": exchange_id,
            "exchangeName": exchange.get("name") or exchange.get("Name"),
            "previousAuthScheme": exchange.get("targetAuthScheme") or exchange.get("TargetAuthScheme"),
            "nextAuthScheme": auth_scheme,
            "targetUrl": exchange.get("targetUrl") or exchange.get("TargetUrl"),
            "transformerType": exchange.get("transformerType") or exchange.get("TransformerType"),
        })
        if args.dry_run:
            report["verdict"] = "pass"
            _write_json(args.json_out, report)
            print("LLM Gateway ASR credential rotate: DRY-RUN PASS")
            print(f"- exchange={exchange_id} model={args.model_id} nextAuthScheme={auth_scheme}")
            if args.print_json:
                print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
            return 0

        body = {
            "name": exchange.get("name") or exchange.get("Name"),
            "modelAlias": exchange.get("modelAlias") or exchange.get("ModelAlias"),
            "modelAliases": exchange.get("modelAliases") or exchange.get("ModelAliases"),
            "models": _models(exchange),
            "targetUrl": exchange.get("targetUrl") or exchange.get("TargetUrl"),
            "targetApiKey": new_key,
            "targetAuthScheme": auth_scheme,
            "transformerType": exchange.get("transformerType") or exchange.get("TransformerType"),
            "transformerConfig": exchange.get("transformerConfig") or exchange.get("TransformerConfig"),
            "enabled": bool(exchange.get("enabled") if "enabled" in exchange else exchange.get("Enabled", True)),
            "description": exchange.get("description") or exchange.get("Description"),
        }
        update = _request_json("PUT", _join(args.api_base, f"/api/mds/exchanges/{urllib.parse.quote(exchange_id)}"), body, headers=_bearer(token), timeout=args.timeout)
        _api_data(update, "update exchange")
        report["verdict"] = "pass"
        _write_json(args.json_out, report)
        print("LLM Gateway ASR credential rotate: PASS")
        print(f"- exchange={exchange_id} model={args.model_id} nextAuthScheme={auth_scheme}")
        if args.print_json:
            print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
        return 0
    except Exception as exc:
        report["failures"].append(str(exc))
        _write_json(args.json_out, report)
        print("LLM Gateway ASR credential rotate: FAIL")
        print(f"- {exc}")
        if args.print_json:
            print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
