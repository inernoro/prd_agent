#!/usr/bin/env python3
"""
Seed report-agent.generate::chat shadow comparisons through real MAP APIs.

This is an operations helper for LLM Gateway rollout gates. It intentionally
drives MAP report-agent endpoints instead of /gw/v1 directly, because only MAP
shadow mode writes the llmshadow_comparisons rows used by canary/http gates.
Temporary report/daily-log seed data is removed before exit by default.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_BASE = "http://127.0.0.1:5500"
DEFAULT_COMMIT = ""
APP_CALLER = "report-agent.generate::chat"


@dataclass
class SeedResult:
    week: int
    status: int
    ok: bool
    ai_generation_error: str | None = None
    error: str | None = None
    elapsed_seconds: float = 0


@dataclass
class SeedEvidence:
    started_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    finished_at: str | None = None
    base: str = DEFAULT_BASE
    release_commit: str = DEFAULT_COMMIT
    team_id: str = ""
    template_id: str = ""
    app_caller: str = APP_CALLER
    sample_percent: int = 100
    restore_sample_percent: int = 1
    requested: int = 0
    succeeded: int = 0
    failed: int = 0
    cleanup: dict[str, Any] = field(default_factory=dict)
    shadow_before: dict[str, Any] = field(default_factory=dict)
    shadow_after: dict[str, Any] = field(default_factory=dict)
    results: list[SeedResult] = field(default_factory=list)


class HttpError(RuntimeError):
    def __init__(self, method: str, url: str, status: int, body: str):
        super().__init__(f"{method} {url} failed: HTTP {status}: {body[:500]}")
        self.status = status
        self.body = body


def run(cmd: list[str], *, env: dict[str, str] | None = None, capture: bool = True) -> str:
    result = subprocess.run(
        cmd,
        check=True,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
        env={**os.environ, **(env or {})},
    )
    return result.stdout if capture else ""


def current_git_commit() -> str:
    try:
        return run(["git", "rev-parse", "HEAD"]).strip()
    except Exception:  # noqa: BLE001 - argparse fallback
        return ""


def docker_env(container: str, key: str) -> str:
    return run(["docker", "exec", container, "sh", "-lc", f'printf %s "${key}"']).strip()


def mongosh(database: str, script: str) -> Any:
    out = run(["docker", "exec", "prdagent-mongodb", "mongosh", database, "--quiet", "--eval", script])
    text = out.strip()
    if not text:
        return None
    return json.loads(text)


def request_json(
    method: str,
    url: str,
    payload: Any | None = None,
    token: str | None = None,
    timeout: float = 180,
    allow_error: bool = False,
) -> tuple[int, dict[str, Any]]:
    data = None
    headers = {"Accept": "application/json", "User-Agent": "llmgw-report-agent-shadow-seed/1.0"}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            return resp.status, json.loads(body) if body.strip() else {}
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        if allow_error:
            try:
                return exc.code, json.loads(body) if body.strip() else {}
            except json.JSONDecodeError:
                return exc.code, {"success": False, "error": {"message": body[:500]}}
        raise HttpError(method, url, exc.code, body) from exc


def join_url(base: str, path: str) -> str:
    return base.rstrip("/") + "/" + path.lstrip("/")


def api_data(status: int, doc: dict[str, Any], context: str) -> Any:
    if status >= 400 or doc.get("success") is not True:
        raise RuntimeError(f"{context} failed: status={status} body={json.dumps(doc, ensure_ascii=False)[:500]}")
    return doc.get("data")


def login(base: str, username: str, password: str, timeout: float) -> str:
    status, doc = request_json(
        "POST",
        join_url(base, "/api/v1/auth/login"),
        {"username": username, "password": password, "clientType": "admin"},
        timeout=timeout,
    )
    data = api_data(status, doc, "login") or {}
    token = data.get("accessToken") or data.get("token")
    if not token:
        raise RuntimeError("login succeeded but token is missing")
    return str(token)


def wait_api(base: str, commit: str, timeout_seconds: float) -> None:
    deadline = time.time() + timeout_seconds
    last_error = ""
    while time.time() < deadline:
        try:
            status, doc = request_json("GET", join_url(base, "/api/version"), timeout=10, allow_error=True)
            if status == 200 and str(doc.get("commit") or "") == commit:
                return
            last_error = f"status={status} commit={doc.get('commit')}"
        except Exception as exc:  # noqa: BLE001 - diagnostic loop
            last_error = str(exc)
        time.sleep(2)
    raise RuntimeError(f"API did not become ready for commit {commit}: {last_error}")


def discover_team_template(team_id: str, template_id: str) -> tuple[str, str]:
    if team_id and template_id:
        return team_id, template_id
    script = r"""
const team = db.report_teams.findOne({});
if (!team) throw new Error("report_teams is empty");
const template = db.report_templates.findOne({$or:[{TeamId:team._id},{TeamIds:team._id}]})
  || db.report_templates.findOne({IsDefault:true})
  || db.report_templates.findOne({});
if (!template) throw new Error("report_templates is empty");
print(JSON.stringify({teamId: team._id, templateId: template._id, teamName: team.Name, templateName: template.Name}));
"""
    data = mongosh("prdagent", script)
    return team_id or data["teamId"], template_id or data["templateId"]


def shadow_summary(commit: str) -> dict[str, Any]:
    script = f"""
const commit = {json.dumps(commit)};
const app = {json.dumps(APP_CALLER)};
const q = {{ReleaseCommit: commit, AppCallerCode: app}};
const total = db.llmshadow_comparisons.countDocuments(q);
const critical = db.llmshadow_comparisons.countDocuments({{...q, HasCritical: true}});
const httpFail = db.llmshadow_comparisons.countDocuments({{...q, HttpOk: false}});
const byKind = db.llmshadow_comparisons.aggregate([
  {{$match:q}},
  {{$group:{{_id:"$Kind", total:{{$sum:1}}, allMatch:{{$sum:{{$cond:["$AllMatch",1,0]}}}}, critical:{{$sum:{{$cond:["$HasCritical",1,0]}}}}, httpFail:{{$sum:{{$cond:[{{$eq:["$HttpOk", false]}},1,0]}}}}}}}},
  {{$sort:{{total:-1}}}}
]).toArray();
print(JSON.stringify({{releaseCommit: commit, appCaller: app, total, critical, httpFail, byKind}}));
"""
    return mongosh("llm_gateway", script)


def set_shadow_sample(percent: int) -> None:
    run(
        ["scripts/llmgw-restore-shadow-safe.sh"],
        env={"LLMGW_RESTORE_SHADOW_FULL_SAMPLE_PERCENT": str(percent)},
        capture=False,
    )


def ensure_temp_member(team_id: str) -> None:
    script = f"""
db.report_team_members.updateOne(
  {{UserId:"root", TeamId:{json.dumps(team_id)}}},
  {{$setOnInsert:{{
    _id:"llmgw-shadow-seed-root",
    TeamId:{json.dumps(team_id)},
    UserId:"root",
    UserName:"LLMGW Shadow Seed",
    AvatarFileName:null,
    Role:"member",
    JobTitle:"llmgw-shadow-seed",
    IdentityMappings:{{}},
    JoinedAt:new Date()
  }}}},
  {{upsert:true}}
);
print(JSON.stringify({{ok:true}}));
"""
    mongosh("prdagent", script)


def cleanup_seed_data(team_id: str, week_year: int) -> dict[str, Any]:
    script = f"""
const teamId = {json.dumps(team_id)};
const weekYear = {int(week_year)};
const member = db.report_team_members.deleteMany({{
  UserId:"root",
  TeamId:teamId,
  Role:"member",
  JobTitle:"llmgw-shadow-seed"
}});
const reports = db.report_weekly_reports.deleteMany({{
  UserId:"root",
  TeamId:teamId,
  WeekYear:weekYear
}});
const start = new Date(Date.UTC(weekYear, 0, 1));
const end = new Date(Date.UTC(weekYear + 1, 0, 1));
const daily = db.report_daily_logs.deleteMany({{
  UserId:"root",
  Date:{{$gte:start, $lt:end}}
}});
print(JSON.stringify({{
  memberDeleted: member.deletedCount,
  reportsDeleted: reports.deletedCount,
  dailyLogsDeleted: daily.deletedCount
}}));
"""
    return mongosh("prdagent", script)


def save_daily_log(base: str, token: str, week_year: int, week: int, timeout: float) -> None:
    monday = datetime.fromisocalendar(week_year, week, 1)
    payload = {
        "date": monday.strftime("%Y-%m-%d"),
        "items": [
            {
                "content": f"LLMGW shadow seed W{week}: validated report-agent gateway routing, release evidence, rollback notes, and model response observability.",
                "category": "development",
                "tags": ["LLMGW"],
                "durationMinutes": 45,
            },
            {
                "content": f"LLMGW shadow seed W{week}: reviewed same-commit shadow comparison counts and confirmed critical/httpFail gates.",
                "category": "testing",
                "tags": ["Gateway"],
                "durationMinutes": 30,
            },
        ],
    }
    status, doc = request_json(
        "POST",
        join_url(base, "/api/report-agent/daily-logs"),
        payload,
        token=token,
        timeout=timeout,
    )
    api_data(status, doc, f"save daily log W{week}")


def create_ai_draft(
    base: str,
    token: str,
    team_id: str,
    template_id: str,
    week_year: int,
    week: int,
    timeout: float,
) -> SeedResult:
    payload = {
        "teamId": team_id,
        "templateId": template_id,
        "weekYear": week_year,
        "weekNumber": week,
        "creationMode": "ai-draft",
    }
    started = time.time()
    try:
        status, doc = request_json(
            "POST",
            join_url(base, "/api/report-agent/reports"),
            payload,
            token=token,
            timeout=timeout,
            allow_error=True,
        )
        data = doc.get("data") if isinstance(doc.get("data"), dict) else {}
        error = doc.get("error") if isinstance(doc.get("error"), dict) else {}
        return SeedResult(
            week=week,
            status=status,
            ok=status == 200 and doc.get("success") is True,
            ai_generation_error=data.get("aiGenerationError"),
            error=error.get("message") or error.get("code"),
            elapsed_seconds=round(time.time() - started, 3),
        )
    except Exception as exc:  # noqa: BLE001 - evidence result
        return SeedResult(
            week=week,
            status=0,
            ok=False,
            error=str(exc),
            elapsed_seconds=round(time.time() - started, 3),
        )


def write_evidence(path: str, evidence: SeedEvidence) -> None:
    if not path:
        return
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    payload = {
        **evidence.__dict__,
        "results": [r.__dict__ for r in evidence.results],
    }
    Path(path).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Seed report-agent LLM Gateway shadow comparisons")
    parser.add_argument("--base", default=os.environ.get("PRD_AGENT_BASE", DEFAULT_BASE))
    parser.add_argument("--release-commit", default=os.environ.get("LLMGW_RELEASE_COMMIT") or current_git_commit())
    parser.add_argument("--team-id", default=os.environ.get("LLMGW_REPORT_AGENT_SEED_TEAM_ID", ""))
    parser.add_argument("--template-id", default=os.environ.get("LLMGW_REPORT_AGENT_SEED_TEMPLATE_ID", ""))
    parser.add_argument("--week-year", type=int, default=int(os.environ.get("LLMGW_REPORT_AGENT_SEED_WEEK_YEAR", "2099")))
    parser.add_argument("--start-week", type=int, default=int(os.environ.get("LLMGW_REPORT_AGENT_SEED_START_WEEK", "1")))
    parser.add_argument("--iterations", type=int, default=int(os.environ.get("LLMGW_REPORT_AGENT_SEED_ITERATIONS", "30")))
    parser.add_argument("--timeout", type=float, default=float(os.environ.get("LLMGW_REPORT_AGENT_SEED_TIMEOUT", "150")))
    parser.add_argument("--wait-api-seconds", type=float, default=120)
    parser.add_argument("--sample-percent", type=int, default=100)
    parser.add_argument("--restore-sample-percent", type=int, default=1)
    parser.add_argument("--root-username", default=os.environ.get("ROOT_ACCESS_USERNAME", ""))
    parser.add_argument("--root-password", default=os.environ.get("ROOT_ACCESS_PASSWORD", ""))
    parser.add_argument("--keep-seed-data", action="store_true")
    parser.add_argument("--no-sample-raise", action="store_true")
    parser.add_argument("--evidence-out", default=os.environ.get("LLMGW_REPORT_AGENT_SEED_EVIDENCE_OUT", ""))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.release_commit:
        raise RuntimeError("release commit is required; pass --release-commit or run inside a git checkout")
    evidence = SeedEvidence(
        base=args.base,
        release_commit=args.release_commit,
        sample_percent=args.sample_percent,
        restore_sample_percent=args.restore_sample_percent,
        requested=args.iterations,
    )
    team_id = ""
    try:
        team_id, template_id = discover_team_template(args.team_id, args.template_id)
        evidence.team_id = team_id
        evidence.template_id = template_id
        evidence.shadow_before = shadow_summary(args.release_commit)

        if not args.no_sample_raise:
            print(f"Raising shadow sample to {args.sample_percent}%")
            set_shadow_sample(args.sample_percent)
            wait_api(args.base, args.release_commit, args.wait_api_seconds)

        username = args.root_username or docker_env("prdagent-api", "ROOT_ACCESS_USERNAME")
        password = args.root_password or docker_env("prdagent-api", "ROOT_ACCESS_PASSWORD")
        token = login(args.base, username, password, args.timeout)
        ensure_temp_member(team_id)
        cleanup_seed_data(team_id, args.week_year)
        ensure_temp_member(team_id)

        for offset in range(args.iterations):
            week = args.start_week + offset
            save_daily_log(args.base, token, args.week_year, week, args.timeout)
            result = create_ai_draft(args.base, token, team_id, template_id, args.week_year, week, args.timeout)
            evidence.results.append(result)
            if result.ok:
                evidence.succeeded += 1
            else:
                evidence.failed += 1
            print(
                f"week={week} status={result.status} ok={int(result.ok)} "
                f"elapsed={result.elapsed_seconds}s aiGenerationError={bool(result.ai_generation_error)}"
            )

        print("Waiting for async shadow writes")
        time.sleep(20)
        evidence.shadow_after = shadow_summary(args.release_commit)
        return 0 if evidence.failed == 0 else 1
    finally:
        try:
            if team_id and not args.keep_seed_data:
                evidence.cleanup = cleanup_seed_data(team_id, args.week_year)
        finally:
            if not args.no_sample_raise:
                print(f"Restoring shadow sample to {args.restore_sample_percent}%")
                set_shadow_sample(args.restore_sample_percent)
            evidence.finished_at = datetime.now(timezone.utc).isoformat()
            write_evidence(args.evidence_out, evidence)
            print(json.dumps({
                "requested": evidence.requested,
                "succeeded": evidence.succeeded,
                "failed": evidence.failed,
                "shadowBefore": evidence.shadow_before,
                "shadowAfter": evidence.shadow_after,
                "cleanup": evidence.cleanup,
            }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    sys.exit(main())
