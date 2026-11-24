#!/usr/bin/env python3
"""Snapshot the approved public announcement source; resume from durable local state.

Uses only the Python standard library. HTML stays in memory; bounded response
facts and per-attempt outcomes are retained beside the resumable state. All
output paths must resolve to F: on Windows. No account or credential is used.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import hashlib
from html import unescape
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

SOURCE = "https://helper.weixin12315.com/945f"
USER_AGENT = "MAP-VersionAnnouncements/1.0"
MAX_BYTES = 2 * 1024 * 1024
VERSION = re.compile(r"V\s*(\d{1,6})\s*\.\s*(\d{1,6})\s*\.\s*(\d{1,6})(?![\d.])", re.I)
DATE = re.compile(r"(?:20\d{2}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日?|20\d{2}[-./]\d{1,2}[-./]\d{1,2})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?")


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def approved_url(raw: str) -> str:
    url = urllib.parse.urljoin(SOURCE, unescape(raw))
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname != "helper.weixin12315.com" or parsed.port not in (None, 443) or parsed.username or parsed.password:
        raise ValueError("Only the approved public announcement origin is allowed")
    if parsed.path == "/945f":
        if parsed.query and not re.fullmatch(r"page=[1-9]\d{0,3}", parsed.query):
            raise ValueError("Invalid announcement list query")
    elif not re.fullmatch(r"/945f/[A-Za-z0-9_-]+", parsed.path) or parsed.query:
        raise ValueError("Only announcement list and detail paths are allowed")
    return urllib.parse.urlunsplit(("https", "helper.weixin12315.com", parsed.path, parsed.query, ""))


class Node:
    def __init__(self, tag: str = "root", attrs: dict[str, str] | None = None):
        self.tag, self.attrs, self.children = tag, attrs or {}, []

    def text(self) -> str:
        return "".join(child.text() if isinstance(child, Node) else child for child in self.children)

    def walk(self):
        yield self
        for child in self.children:
            if isinstance(child, Node):
                yield from child.walk()


class Document(HTMLParser):
    VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}

    def __init__(self, html: str):
        super().__init__(convert_charrefs=True)
        self.root = Node()
        self.stack = [self.root]
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        node = Node(tag, dict(attrs))
        self.stack[-1].children.append(node)
        if tag not in self.VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.stack[-1].children.append(Node(tag, dict(attrs)))

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                break

    def handle_data(self, text):
        if not any(node.tag in {"script", "style"} for node in self.stack):
            self.stack[-1].children.append(text)


def parse_list(html: str, page: int) -> tuple[list[dict], bool, int]:
    items, has_next, expected = {}, False, page
    for node in Document(html).root.walk():
        if node.tag != "a" or not node.attrs.get("href"):
            continue
        try:
            url = approved_url(node.attrs["href"])
        except ValueError:
            continue
        parts = urllib.parse.urlsplit(url)
        if parts.path == "/945f":
            query = urllib.parse.parse_qs(parts.query)
            number = int(query.get("page", ["1"])[0])
            expected = max(expected, number)
            has_next |= number == page + 1
            continue
        title = re.sub(r"\s+", " ", node.text()).strip()
        if title:
            items.setdefault(url, {"id": parts.path.rsplit("/", 1)[-1], "url": url, "title": title, "sourcePage": page})
    if not items:
        raise ValueError("Announcement list contains no recognized titled entries")
    return list(items.values()), has_next, expected


def title_identity(title: str) -> tuple[str, str]:
    matches = list(VERSION.finditer(title))
    if len(matches) != 1:
        return "", ""
    match = matches[0]
    app = title[:match.start()].strip(" -—：:")
    if not app:
        return "", ""
    # Same observed source alias as ProductAnnouncementSource.ApplicationKey.
    app = {"品牌后台基础": "品牌商后台基础"}.get(app, app)
    version = "V" + ".".join(str(int(part)) for part in match.groups())
    return app, version


def parse_detail(html: str) -> dict:
    nodes = list(Document(html).root.walk())
    title = next((node.text().strip() for node in nodes if node.tag == "h1" and node.text().strip()), "")
    if not title:
        title = next((node.text().split(" | ")[0].strip() for node in nodes if node.tag == "title"), "")
    paragraphs = [node for node in nodes if "editor_js--paragraph" in node.attrs.get("class", "").split()]
    if not paragraphs:
        raise ValueError("Announcement detail has no recognized article content")
    # The source places the team's dateline at the end of its article body.
    # Use a date-only paragraph, never a date embedded in a business example.
    nonempty = [node.text().strip() for node in paragraphs if node.text().strip()]
    final_dateline = nonempty[-1] if nonempty and DATE.fullmatch(nonempty[-1]) else ""
    aligned = [node.text().strip() for node in paragraphs if "editor_js--paragraph__align-right" in node.attrs.get("class", "").split() and DATE.fullmatch(node.text().strip())]
    published = (aligned or [final_dateline])[-1]
    footer = ""
    for node in nodes:
        classes = set(node.attrs.get("class", "").split())
        if {"flex", "items-center", "mt-10", "text-xs", "text-gray-400"} <= classes:
            for child in node.walk():
                if "ml-1" in child.attrs.get("class", "").split() and DATE.fullmatch(child.text().strip()):
                    footer = child.text().strip()
    return {"detailTitle": title, "publishedAtRaw": published, "footerTimeRaw": footer,
            "dateEvidence": {"publishedAt": "article final date-only paragraph" if published else "missing", "footerTime": "article footer clock/date container" if footer else "missing"}}


def response_summary(html: str) -> dict:
    """Retain diagnostic page facts even when list/detail parsing fails."""
    nodes = list(Document(html).root.walk())
    title = next((node.text().strip()[:220] for node in nodes if node.tag == "title"), "")
    paragraphs = [node for node in nodes if "editor_js--paragraph" in node.attrs.get("class", "").split()]
    return {"pageTitle": title, "articleParagraphs": len(paragraphs),
            "omitted": "Article/media text, scripts and non-whitelisted headers omitted"}


def atomic_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


class RestrictedRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        approved_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class Fetcher:
    def __init__(self, audit: Path, run_id: str, delay: float, retries: int):
        self.audit, self.run_id, self.delay, self.retries = audit, run_id, delay, retries
        self.lock, self.next_request = threading.Lock(), 0.0

    def write_audit(self, record: dict) -> None:
        with self.lock:
            self.audit.parent.mkdir(parents=True, exist_ok=True)
            with self.audit.open("a", encoding="utf-8") as output:
                output.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")

    def fetch(self, url: str, phase: str, source_page: int, parser):
        url = approved_url(url)
        last_error = ""
        for attempt in range(1, self.retries + 1):
            with self.lock:
                wait = max(0.0, self.next_request - time.monotonic())
                self.next_request = max(self.next_request, time.monotonic()) + self.delay
            if wait:
                time.sleep(wait)
            started, clock = utc_now(), time.monotonic()
            audit = {"runId": self.run_id, "requestId": uuid.uuid4().hex, "service": "Miduo public announcements", "operation": phase,
                     "url": url, "method": "GET", "sourcePage": source_page, "attempt": attempt, "startedAt": started,
                     "userAgent": USER_AGENT, "timeoutSeconds": 25, "responseLimitBytes": MAX_BYTES, "receivedResponse": False}
            try:
                request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html"})
                with urllib.request.build_opener(RestrictedRedirects()).open(request, timeout=25) as response:
                    approved_url(response.url)
                    audit.update(receivedResponse=True, httpStatus=response.status, contentType=response.headers.get("Content-Type", ""))
                    body = response.read(MAX_BYTES + 1)
                audit.update(responseBytes=len(body), responseSha256=hashlib.sha256(body).hexdigest(), truncated=len(body) > MAX_BYTES,
                             bodyOmission="Full public article HTML omitted; retain title/date or list metadata only")
                if len(body) > MAX_BYTES:
                    raise ValueError("Public response exceeds 2 MiB limit")
                html = body.decode("utf-8")
                audit["responseSnapshot"] = response_summary(html)
                result = parser(html)
                if phase == "list":
                    items, has_next, expected = result
                    audit["responseSnapshot"] = {"recognizedEntries": len(items), "hasNext": has_next, "highestPageLink": expected,
                                                   "firstEntries": [{"id": item["id"], "title": item["title"][:180]} for item in items[:2]]}
                else:
                    audit["responseSnapshot"] = {key: value for key, value in result.items() if key != "dateEvidence"}
                    audit["fieldEvidence"] = result["dateEvidence"]
                audit.update(parseSucceeded=True, outcome="succeeded", recoveryAction="persist parsed item")
                return result, attempt
            except Exception as ex:
                last_error = type(ex).__name__ + ": " + str(ex)[:240]
                if isinstance(ex, urllib.error.HTTPError):
                    audit.update(receivedResponse=True, httpStatus=ex.code, contentType=ex.headers.get("Content-Type", ""))
                    body = ex.read(MAX_BYTES + 1)
                    audit.update(responseBytes=len(body), responseSha256=hashlib.sha256(body).hexdigest(), truncated=len(body) > MAX_BYTES,
                                 responseSnapshot=response_summary(body[:MAX_BYTES].decode("utf-8", errors="replace")),
                                 bodyOmission="HTTP error page retained only as bounded title/structure summary")
                audit.update(parseSucceeded=False, outcome="failed", failureClass="parse" if isinstance(ex, (ValueError, UnicodeError)) else "upstream",
                             safeReason=last_error, recoveryAction="retry" if attempt < self.retries else "retain pending item and report failure")
            finally:
                audit.update(finishedAt=utc_now(), elapsedMs=round((time.monotonic() - clock) * 1000))
                self.write_audit(audit)
            if attempt < self.retries:
                time.sleep(min(attempt, 3))
        raise RuntimeError(last_error)


def validate_snapshot(snapshot: dict) -> dict:
    if snapshot.get("schemaVersion") != 1 or snapshot.get("sourceUrl") != SOURCE:
        raise ValueError("Snapshot schema/source is invalid")
    rows = snapshot["records"]
    ids, urls = set(), set()
    for item in rows:
        if item["id"] in ids or item["url"] in urls:
            raise ValueError("Duplicate announcement identity")
        ids.add(item["id"])
        urls.add(approved_url(item["url"]))
        if item["id"] != urllib.parse.urlsplit(item["url"]).path.rsplit("/", 1)[-1]:
            raise ValueError("Announcement ID does not match URL")
        for key in ("title", "applicationName", "version", "publishedAtRaw", "footerTimeRaw", "detailStatus", "lastError", "fetchedAt"):
            if not isinstance(item.get(key), str):
                raise ValueError("Snapshot missing string field " + key)
        if item["detailStatus"] not in {"pending", "succeeded", "failed"}:
            raise ValueError("Invalid detail status")
    if snapshot["scanCompleted"] and snapshot["pagesScanned"] != snapshot["expectedPages"]:
        raise ValueError("A complete scan must reach every expected page")
    return {"records": len(rows), "detailsSucceeded": sum(row["detailStatus"] == "succeeded" for row in rows),
            "detailsFailed": sum(row["detailStatus"] == "failed" for row in rows), "detailsPending": sum(row["detailStatus"] == "pending" for row in rows),
            "withApplicationAndVersion": sum(bool(row["applicationName"] and row["version"]) for row in rows),
            "withPublishedAt": sum(bool(row["publishedAtRaw"]) for row in rows), "withFooterTime": sum(bool(row["footerTimeRaw"]) for row in rows),
            "pagesScanned": snapshot["pagesScanned"], "expectedPages": snapshot["expectedPages"], "scanCompleted": snapshot["scanCompleted"]}


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    options = argparse.ArgumentParser(description=__doc__)
    options.add_argument("--output", type=Path, default=root / "prd-api/src/PrdAgent.Api/Data/product-announcements.initial.json")
    options.add_argument("--state-dir", type=Path, default=root / ".agent-workspace/announcement-crawl-evidence")
    options.add_argument("--delay", type=float, default=0.2)
    options.add_argument("--retries", type=int, default=3)
    options.add_argument("--workers", type=int, default=3)
    options.add_argument("--refresh", action="store_true", help="Rescan lists while retaining successful detail records")
    options.add_argument("--validate-only", action="store_true", help="Validate the generated snapshot without making any network request")
    args = options.parse_args()
    for target in (args.output, args.state_dir):
        if target.resolve().drive and target.resolve().drive.upper() != "F:":
            options.error("All snapshot and evidence output must remain on F:")
    if not (0.1 <= args.delay <= 30 and 1 <= args.retries <= 5 and 1 <= args.workers <= 3):
        options.error("Use delay 0.1..30, retries 1..5, workers 1..3")
    if args.validate_only:
        print(json.dumps(validate_snapshot(json.loads(args.output.read_text(encoding="utf-8"))), ensure_ascii=False), flush=True)
        return 0
    args.state_dir.mkdir(parents=True, exist_ok=True)
    checkpoint = args.state_dir / "checkpoint.json"
    state = json.loads(checkpoint.read_text(encoding="utf-8")) if checkpoint.exists() else {
        "schemaVersion": 1, "sourceUrl": SOURCE, "fetchedAt": utc_now(), "scanCompleted": False,
        "expectedPages": 1, "pagesScanned": 0, "nextPage": 1, "records": []}
    if args.refresh:
        state.update(scanCompleted=False, pagesScanned=0, nextPage=1)
    rows = {item["id"]: item for item in state["records"]}
    for item in rows.values():
        item["applicationName"], item["version"] = title_identity(item["title"])
    fetcher = Fetcher(args.state_dir / "responses.jsonl", uuid.uuid4().hex, args.delay, args.retries)

    def save() -> None:
        state["records"] = list(rows.values())
        atomic_json(checkpoint, state)

    while not state["scanCompleted"]:
        page = state["nextPage"]
        if page > 1000:
            raise RuntimeError("List scan exceeded 1000-page safety limit")
        url = SOURCE + ("" if page == 1 else "?page=" + str(page))
        try:
            (items, has_next, expected), _ = fetcher.fetch(url, "list", page, lambda html: parse_list(html, page))
        except RuntimeError as ex:
            state["listError"] = str(ex)
            save()
            raise
        for item in items:
            app, version = title_identity(item["title"])
            existing = rows.get(item["id"], {})
            rows[item["id"]] = {**item, "applicationName": app, "version": version, "publishedAtRaw": "", "footerTimeRaw": "",
                                "fetchedAt": "", "detailStatus": "pending", "lastError": "", "attempts": 0, **existing}
        state.update(pagesScanned=page, expectedPages=max(state["expectedPages"], expected), nextPage=page + 1,
                     scanCompleted=not has_next, listError="")
        save()
        print(json.dumps({"phase": "list", "page": page, "discovered": len(rows), "hasNext": has_next}, ensure_ascii=False), flush=True)
    pending = [item for item in rows.values() if item["detailStatus"] != "succeeded"]
    print(json.dumps({"phase": "details", "pending": len(pending), "alreadySucceeded": len(rows) - len(pending)}, ensure_ascii=False), flush=True)

    def detail(item):
        try:
            result, attempts = fetcher.fetch(item["url"], "detail", item["sourcePage"], parse_detail)
            return item["id"], result, attempts, ""
        except RuntimeError as ex:
            return item["id"], None, args.retries, str(ex)

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        for number, (item_id, result, attempts, error) in enumerate(pool.map(detail, pending), 1):
            item = rows[item_id]
            item.update(attempts=item["attempts"] + attempts, fetchedAt=utc_now(), lastError=error, detailStatus="failed" if error else "succeeded")
            if result:
                item.update(publishedAtRaw=result["publishedAtRaw"], footerTimeRaw=result["footerTimeRaw"])
            save()
            if number % 10 == 0 or error or number == len(pending):
                print(json.dumps({"phase": "details", "completedThisRun": number, "pendingThisRun": len(pending), "lastId": item_id, "error": error}, ensure_ascii=False), flush=True)
    snapshot = {key: value for key, value in state.items() if key not in {"nextPage", "listError"}}
    # A no-network resume must not claim that the source was fetched again.
    snapshot["fetchedAt"] = max([state["fetchedAt"]] + [item["fetchedAt"] for item in rows.values() if item["fetchedAt"]])
    summary = validate_snapshot(snapshot)
    atomic_json(args.output, snapshot)
    summary.update(sourceUrl=SOURCE, snapshotSha256=hashlib.sha256(args.output.read_bytes()).hexdigest(), snapshotBytes=args.output.stat().st_size,
                   fetchedAt=snapshot["fetchedAt"], auditFile="responses.jsonl", checkpointFile="checkpoint.json")
    atomic_json(args.state_dir / "summary.json", summary)
    atomic_json(args.state_dir / "failures.json", [item for item in rows.values() if item["detailStatus"] != "succeeded"])
    print(json.dumps(summary, ensure_ascii=False), flush=True)
    return 0 if summary["scanCompleted"] and not summary["detailsFailed"] and not summary["detailsPending"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
