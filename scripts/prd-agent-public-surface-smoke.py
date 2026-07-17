#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Callable


@dataclass(frozen=True)
class HttpResult:
    url: str
    status: int
    content_type: str
    body: bytes


class EntryAssetParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.scripts: list[str] = []
        self.styles: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = {key.lower(): value or "" for key, value in attrs}
        if tag.lower() == "script" and values.get("src"):
            self.scripts.append(values["src"])
        if tag.lower() == "link" and "stylesheet" in values.get("rel", "").lower() and values.get("href"):
            self.styles.append(values["href"])


def fetch_once(url: str, timeout: float) -> HttpResult:
    request = urllib.request.Request(url, headers={"User-Agent": "prd-agent-public-surface-smoke/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return HttpResult(
                url=response.geturl(),
                status=int(response.status),
                content_type=response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower(),
                body=response.read(),
            )
    except urllib.error.HTTPError as exc:
        return HttpResult(
            url=exc.geturl(),
            status=int(exc.code),
            content_type=exc.headers.get("Content-Type", "").split(";", 1)[0].strip().lower(),
            body=exc.read(),
        )
    except urllib.error.URLError as exc:
        return HttpResult(
            url=url,
            status=0,
            content_type="network-error",
            body=str(exc.reason).encode("utf-8", errors="replace"),
        )


def local_asset_urls(base: str, values: list[str]) -> list[str]:
    base_parts = urllib.parse.urlsplit(base)
    urls: list[str] = []
    for value in values:
        if not value or value.startswith(("data:", "blob:")):
            continue
        absolute = urllib.parse.urljoin(base, value)
        parts = urllib.parse.urlsplit(absolute)
        if parts.scheme in {"http", "https"} and parts.netloc == base_parts.netloc:
            urls.append(absolute)
    return list(dict.fromkeys(urls))


def health_state(body: bytes) -> str | None:
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    state = payload.get("status")
    if state is None and isinstance(payload.get("data"), dict):
        state = payload["data"].get("status")
    return str(state).strip().lower() if state is not None else None


def api_identity_is_healthy(body: bytes) -> bool:
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return False
    return (
        isinstance(payload, dict)
        and bool(str(payload.get("service") or "").strip())
        and bool(str(payload.get("commit") or "").strip())
    )


def json_text_field(body: bytes, field: str) -> str | None:
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    value = payload.get(field)
    return str(value).strip() if value is not None else None


def probe_once(
    base: str,
    api_health_path: str,
    root_health_path: str,
    llmgw_page_path: str,
    llmgw_console_health_path: str,
    llmgw_serving_health_path: str,
    timeout: float,
    fetcher: Callable[[str, float], HttpResult] = fetch_once,
    expected_commit: str | None = None,
) -> dict[str, object]:
    checks: list[dict[str, object]] = []
    failures: list[str] = []

    def fetch_check(name: str, url: str, expected_type: str | None = None) -> HttpResult:
        result = fetcher(url, timeout)
        ok = result.status == 200 and len(result.body) > 0
        if expected_type == "html":
            ok = ok and result.content_type in {"text/html", "application/xhtml+xml"}
        if expected_type == "json":
            ok = ok and result.content_type == "application/json"
        checks.append(
            {
                "name": name,
                "url": url,
                "status": result.status,
                "contentType": result.content_type,
                "bytes": len(result.body),
                "sha256": hashlib.sha256(result.body).hexdigest(),
                "ok": ok,
            }
        )
        if not ok:
            failures.append(f"{name} failed: status={result.status} type={result.content_type} bytes={len(result.body)}")
        return result

    root_url = urllib.parse.urljoin(base, "/")
    root = fetch_check("main-page", root_url, "html")
    parser = EntryAssetParser()
    if root.status == 200 and root.body:
        parser.feed(root.body.decode("utf-8", errors="replace"))
    scripts = local_asset_urls(root_url, parser.scripts)
    styles = local_asset_urls(root_url, parser.styles)
    if not scripts:
        failures.append("main-page does not reference a same-origin JavaScript entry asset")
    if not styles:
        failures.append("main-page does not reference a same-origin CSS entry asset")

    for index, asset_url in enumerate(scripts, start=1):
        result = fetch_check(f"entry-js-{index}", asset_url)
        type_ok = result.content_type in {"application/javascript", "text/javascript", "application/x-javascript"}
        if not type_ok:
            failures.append(f"entry-js-{index} has unexpected MIME: {result.content_type}")
    for index, asset_url in enumerate(styles, start=1):
        result = fetch_check(f"entry-css-{index}", asset_url)
        if result.content_type != "text/css":
            failures.append(f"entry-css-{index} has unexpected MIME: {result.content_type}")

    root_health = fetch_check("root-health", urllib.parse.urljoin(base, root_health_path), "json")
    root_health_state = health_state(root_health.body)
    if root_health.status == 200 and root_health_state not in {"healthy", "ok", "ready", "success"}:
        failures.append(f"root-health business status is not healthy: {root_health_state or 'missing'}")

    api = fetch_check("api-version", urllib.parse.urljoin(base, api_health_path), "json")
    api_state = health_state(api.body)
    if api.status == 200 and api_state not in {"healthy", "ok", "ready", "success"} and not api_identity_is_healthy(api.body):
        failures.append(f"api-version identity is not healthy: {api_state or 'missing'}")
    expected_commit = (expected_commit or "").removeprefix("sha-").strip().lower()
    if expected_commit and api.status == 200:
        api_commit = (json_text_field(api.body, "commit") or "").lower()
        if api_commit != expected_commit:
            failures.append(f"api-version commit mismatch: expected={expected_commit} actual={api_commit or 'missing'}")

    fetch_check("llmgw-page", urllib.parse.urljoin(base, llmgw_page_path), "html")
    console_health = fetch_check("llmgw-console-health", urllib.parse.urljoin(base, llmgw_console_health_path), "json")
    serving_health = fetch_check("llmgw-serving-health", urllib.parse.urljoin(base, llmgw_serving_health_path), "json")
    for name, result in (("llmgw-console-health", console_health), ("llmgw-serving-health", serving_health)):
        state = health_state(result.body)
        if result.status == 200 and state not in {"healthy", "ok", "ready", "success"}:
            failures.append(f"{name} business status is not healthy: {state or 'missing'}")
    if expected_commit and serving_health.status == 200:
        serving_commit = (json_text_field(serving_health.body, "commit") or "").lower()
        if serving_commit != expected_commit:
            failures.append(
                f"llmgw-serving-health commit mismatch: expected={expected_commit} actual={serving_commit or 'missing'}"
            )

    return {
        "verdict": "pass" if not failures else "fail",
        "base": base,
        "checkedAt": datetime.now(timezone.utc).isoformat(),
        "checks": checks,
        "failures": failures,
    }


def write_json(path: str, payload: dict[str, object]) -> None:
    output = Path(path)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f"{output.name}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(output)


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify the public product surface after a production release")
    parser.add_argument("--base", required=True)
    parser.add_argument("--api-health-path", default="/api/version")
    parser.add_argument("--root-health-path", default="/health")
    parser.add_argument("--llmgw-page-path", default="/llmgw/")
    parser.add_argument("--llmgw-console-health-path", default="/llmgw/gw/healthz")
    parser.add_argument("--llmgw-serving-health-path", default="/llmgw/gw/v1/healthz")
    parser.add_argument("--attempts", type=int, default=12)
    parser.add_argument("--interval", type=float, default=5.0)
    parser.add_argument("--timeout", type=float, default=15.0)
    parser.add_argument("--expect-commit", default="")
    parser.add_argument("--json-out")
    args = parser.parse_args()

    if args.attempts < 1 or args.interval < 0 or args.timeout <= 0:
        parser.error("attempts must be positive, interval non-negative, and timeout positive")
    base = args.base.rstrip("/") + "/"
    result: dict[str, object] = {}
    for attempt in range(1, args.attempts + 1):
        result = probe_once(
            base,
            args.api_health_path,
            args.root_health_path,
            args.llmgw_page_path,
            args.llmgw_console_health_path,
            args.llmgw_serving_health_path,
            args.timeout,
            expected_commit=args.expect_commit,
        )
        result["attempt"] = attempt
        result["attemptsConfigured"] = args.attempts
        if result["verdict"] == "pass":
            break
        if attempt < args.attempts:
            time.sleep(args.interval)

    if args.json_out:
        write_json(args.json_out, result)
    print(
        f"Public surface smoke: {str(result.get('verdict', 'fail')).upper()} "
        f"checks={len(result.get('checks', []))} failures={len(result.get('failures', []))} "
        f"attempt={result.get('attempt', 0)}"
    )
    for failure in result.get("failures", []):
        print(f"- {failure}")
    return 0 if result.get("verdict") == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
