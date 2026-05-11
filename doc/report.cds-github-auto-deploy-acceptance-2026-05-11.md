# CDS GitHub Auto Deploy Acceptance Report

Date: 2026-05-11
Scope: Verify whether `inernoro/prd_agent` `main` pushes are automatically deployed by public CDS.
Result: **Failed / not accepted**

## Summary

GitHub webhook delivery reaches the public CDS instance and the dispatcher classifies the `push` event as a deploy request for `prd-agent-main`.

However, the target branch does not actually run a new deployment:

- Webhook received `push` for `refs/heads/main`.
- Dispatch decision was `deploy prd-agent-main@3c3138f`.
- Branch metadata `githubCommitSha` was updated to `3c3138f44c5a89cbc86ca785f015fc0a6a26f02a`.
- Branch runtime state stayed `idle`.
- Services stayed `stopped`.
- Branch deployment logs did not record a new deployment for `3c3138f`.
- Actual deployed `commitSha` stayed at older `4ada88ea`.

Therefore the failure is **after webhook dispatch decision and before/inside internal deploy execution**.

## Important Context For Sync Agent

Do not validate this against `localhost`. GitHub does not deliver webhooks to local `localhost:9900`.

Use the public CDS instance:

```bash
export CDS_HOST=https://cds.miduo.org
export AI_ACCESS_KEY='<provided out of band>'
```

Do not commit or print the real access key.

The public CDS project id is:

```text
prd-agent
```

The local/in-app browser URL may show another project id such as:

```text
dd33f970f537
```

That id belongs to the local CDS state and is not the public CDS project id used for GitHub webhook delivery verification.

## Test Commit

The verification push was an empty commit:

```text
3c3138f4 test(cds): verify github auto deploy
```

It was pushed to:

```text
origin/main
```

## Evidence

### 1. Webhook delivery exists

Filtered public CDS webhook logs showed:

```json
{
  "receivedAt": "2026-05-11T09:17:32.694Z",
  "event": "push",
  "repoFullName": "inernoro/prd_agent",
  "ref": "refs/heads/main",
  "commitSha": "3c3138f",
  "commitMessage": "test(cds): verify github auto deploy",
  "actor": "inernoro",
  "dispatchAction": "deploy",
  "dispatchReason": "deploy prd-agent-main@3c3138f"
}
```

This proves GitHub did deliver the `push` event and CDS did not ignore it.

### 2. Branch metadata changed but runtime deployment did not

Public CDS branch status for `prd-agent-main` showed:

```json
{
  "id": "prd-agent-main",
  "projectId": "prd-agent",
  "branch": "main",
  "status": "idle",
  "githubCommitSha": "3c3138f44c5a89cbc86ca785f015fc0a6a26f02a",
  "commitSha": "4ada88ea",
  "subject": "feat(desktop): 新增更新成功说明面板",
  "services": {
    "api": { "status": "stopped" },
    "admin": { "status": "stopped" }
  }
}
```

This proves webhook state stamping happened, but actual deployed code did not advance to the webhook commit.

### 3. Deploy logs did not advance

Latest deploy log for `prd-agent-main` remained:

```json
{
  "startedAt": "2026-05-10T12:29:20.318Z",
  "finishedAt": "2026-05-10T12:30:07.435Z",
  "status": "completed",
  "pull": {
    "title": "已拉取: 41f75559 fix(cds): infra reuse 路径补齐短别名 (D-residual 二段修复) (#586)"
  }
}
```

There was no deployment log for `3c3138f`.

### 4. Pipeline diagnosis

`cdscli diagnose prd-agent-main` returned:

```json
{
  "branchId": "prd-agent-main",
  "status": "idle",
  "services": {
    "api": { "status": "stopped" },
    "admin": { "status": "stopped" }
  },
  "logs": {
    "api": "容器 cds-prd-agent-main-api 不存在，可能已被清理。请重新部署。",
    "admin": "容器 cds-prd-agent-main-admin 不存在，可能已被清理。请重新部署。"
  }
}
```

## Reproduction Commands

Use environment variables. Do not paste secrets into command history in shared contexts.

```bash
CDS_HOST=https://cds.miduo.org AI_ACCESS_KEY="$AI_ACCESS_KEY" \
python3 .claude/skills/cds-deploy-pipeline/cli/cdscli.py auth check
```

```bash
curl -sf -H "X-AI-Access-Key: $AI_ACCESS_KEY" \
  "https://cds.miduo.org/api/cds-system/github/webhook-deliveries?limit=200" \
  | jq '[.deliveries[] | select(.event == "push" or .dispatchAction == "deploy" or .dispatchAction == "branch-created") | {receivedAt,event,repoFullName,ref,commitSha,commitMessage,actor,dispatchAction,dispatchReason,branchId,deployDispatched,deployDedupSkipped,selfStatusBroadcast}]'
```

```bash
CDS_HOST=https://cds.miduo.org AI_ACCESS_KEY="$AI_ACCESS_KEY" \
python3 .claude/skills/cds-deploy-pipeline/cli/cdscli.py branch status prd-agent-main
```

```bash
curl -sf -H "X-AI-Access-Key: $AI_ACCESS_KEY" \
  "https://cds.miduo.org/api/branches/prd-agent-main/logs" \
  | jq '{branchStatus, latest: (.logs[-1] // null | {type, startedAt, finishedAt, status, pull: ([.events[]? | select(.step=="pull")][-1] // null), lastEvents: [.events[-5:][]? | {step,status,title,timestamp}]})}'
```

## Working Hypothesis

The webhook route successfully computes `result.deployRequest`, but the internal fire-and-forget deploy call does not visibly create a deploy log or transition branch state.

Likely inspection points:

- `cds/src/routes/github-webhook.ts`
  - `defaultLocalhostDeploy(config)`
  - deploy dispatch promise is fire-and-forget and only logs errors to stderr.
  - webhook delivery currently records the dispatch decision, but older public CDS does not record `deployDispatched` / dispatch failure.
- `cds/src/routes/branches.ts`
  - `POST /api/branches/:id/deploy`
  - auth / internal headers / route reachability for internal localhost call.
- Public CDS process logs around `2026-05-11T09:17:32Z`
  - Look for `[webhook] deploy dispatch failed for branch=prd-agent-main`.

## Do Not Mask The Bug

Do not manually run:

```bash
cdscli branch deploy prd-agent-main
```

until the automatic path is instrumented or fixed. A manual deploy would make the branch healthy but would hide whether GitHub push auto deploy works.

## Acceptance Criteria For Fix

A later fix should be accepted only when all of these are true:

1. A new push to `inernoro/prd_agent` `main` appears in public CDS Webhook logs.
2. The Webhook log row shows the target branch `prd-agent-main`.
3. The row records deploy dispatch success or a concrete dispatch error.
4. `prd-agent-main.commitSha` advances to the pushed commit.
5. `prd-agent-main.status` transitions through deployment and ends `running`.
6. Deploy logs contain a new build record for the pushed commit.
7. `api` and `admin` services are running.
