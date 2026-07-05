# Evidence Contract

Every acceptance report must let the reader audit how the conclusion was reached.

## Required Chain

Each test unit must connect:

`PR/commit -> changed files -> change assertion -> user-visible surface -> real workflow/API/state -> expected result -> actual evidence -> conclusion`

Rules:
- If a link in the chain is unknown, write `未知` and mark the unit as not fully accepted.
- If a screenshot proves a claim, the claim must be visible in the screenshot or the screenshot is invalid.
- Screenshot references in report tables should be clickable links to the evidence anchor, preferably the full screenshot-name anchor such as `[图01](#fig-01-login-home)` for `{{IMG:01-login-home}}`. Plain `图01` or legacy `#fig-01` is acceptable only as an input that the archive step can normalize when that figure number is unique; repeated figure numbers must use full anchors.
- If API/log/file evidence proves a non-visual claim, show the exact endpoint, file, or command output summary.
- If the tested environment SHA differs from the target SHA, the test cannot pass for that PR or commit.
- The evidence must exercise the changed behavior, not merely the same module. For example, a knowledge-base sync commit requires sync action/result/log evidence; a knowledge-base list screenshot only proves the list page is reachable.
- `CDS` and `CDS Agent` are different evidence domains. CDS platform changes (`cds/` deploy, preview, report center, branch network, extra-services, self-update, scheduler, proxy, smoke) require CDS platform proof such as cdscli/API state, deploy/smoke logs, `/reports`, preview routing, or service status. The prd-admin `/cds-agent` page proves only CDS Agent UI/runtime/session behavior. If a row uses `/cds-agent` to prove CDS platform work, mark the relevance as `无关` or split the row.
- For user-facing changes, page evidence is primary. API/log/database/file evidence is secondary corroboration unless the item is explicitly non-visual or internal-only.

## Page-First Evidence Philosophy

Acceptance is written for a reviewer who first thinks like a user and then verifies like an engineer.

Evidence order:

| Layer | Purpose | Can pass a user-facing claim by itself? |
|-------|---------|------------------------------------------|
| Page evidence | Shows what the user can see or do: route, breadcrumb, state, result, error, disabled action, progress, toast, or rendered content | Yes, when it exercises the changed behavior |
| Interaction evidence | Shows the action that produced the page state: click, submit, upload, retry, refresh, filter, navigation | Yes, when paired with the resulting page state |
| Internal evidence | Explains or confirms the page state: API response, log, database row, queue state, file diff, command output | No, unless the change is non-visual/internal-only |
| Diagnostic evidence | Helps debug why acceptance failed | No; it supports the failure analysis, not the pass verdict |

Rules:
- Start from the smallest page where the user would notice the change. If there is no page, say `无用户可见页面` and explain why.
- Do not lead a daily acceptance report with internal data screenshots. Show the page symptom or user result first, then attach the data that proves cause or persistence.
- A page that only proves entry or navigation is not enough for a behavior change. It can be `入口证据`, but the pass proof must be the changed state or result.
- A CDS Agent entry screenshot is not CDS platform proof. It can show that the workbench loads, but it cannot prove branch deploy, preview routing, report archive, extra-services, scheduler, or self-update behavior.
- For backend-only changes, write the expected user-facing consequence if one exists, such as better error text, disabled unsafe action, retry status, sync badge, or absence of duplicate rows. If no consequence exists, classify the item as `内部能力`.
- A failed page state is valuable evidence. Keep it, mark the visible symptom, and only then show the internal data that explains it.

## Change Assertion Mapping

Before opening any page, derive the assertion being tested from the diff:

| Field | Meaning |
|-------|---------|
| PR/commit | Source change being accepted |
| Changed files | Files or endpoints that reveal the changed behavior |
| Change assertion | Observable behavior the diff claims to add/fix |
| User-visible surface | Page, breadcrumb, UI state, message, list row, detail panel, or visible absence that should reveal the behavior |
| Required proof | The smallest workflow, API, log, database state, or screenshot that can prove it |
| Non-proof | Nearby evidence that is insufficient and must not be counted as pass proof |

Rules:
- `列表可见`, `页面可达`, or `按钮可见` can prove only entry/availability unless the change assertion is entry/availability.
- For sync, restore, upload/compression, auth, async workers, external downloads, deployment/canary, or state transitions, proof must include an action/result pair plus either a page result or API/log/state evidence.
- If the required proof is unsafe, costly, or unavailable, write `未深测` or `关联不足`; do not replace it with a generic page screenshot.

## Depth Budget

Daily/yesterday reports must state their depth before execution:

| Depth | Meaning | Evidence floor |
|-------|---------|----------------|
| `广度冒烟` | Checks reachability and representative surfaces. It does not prove every function works. | One evidence point per major module, clearly labeled as smoke only |
| `深度验收` | Exercises important user workflows, API result paths, and negative paths. | At least 12 screenshots for daily/yesterday reports, plus two evidence points per high-risk runtime module |
| `发布前阻断验收` | Release gate. Blocks on P0/P1, missing critical evidence, or environment drift. | Risk-based; must cover critical workflows and rollback/negative paths |

Rules:
- The depth budget must be computed from machine-collected scope when available: commit count, module count, high-risk module count, open PRs, unpublished branches, planned evidence count, and actual evidence count.
- Do not upgrade `广度冒烟` to `深度验收` in the conclusion after seeing that pages are reachable.
- If the evidence budget is not met, the top verdict must say `广度冒烟`, `有条件通过`, or `不通过`; it must not say deep acceptance passed.
- High-risk modules require an action/result pair or a negative-path/API proof. A single entry-page screenshot is not enough.

## Before Each Test

State this to the user or write it into the execution log:

```text
现在开测：PR/commit <id>
归属模块：<module>
页面位置：<breadcrumb>
测试目的：<claim>
预期结果：<observable result>
```

Do this before observing the result. Never infer the expected result after seeing the page.

## Screenshot Readback

For every screenshot, record:

| Field | Meaning |
|-------|---------|
| 截图名 | File name or report image number |
| 对应测试 | The test unit it proves |
| 用户心智 | What a reviewer should understand from the visible page |
| 是否截歪 | Whether viewport, scroll, or target area is wrong |
| 是否加载完成 | Whether the page finished rendering the target content |
| 是否空白 | Whether the main content is blank |
| 标记是否准确 | Whether color boxes point to the exact claim or problem |
| 结论 | `有效`, `需重拍`, or `作为缺陷证据保留` |

If the screenshot is blank because the product is broken, keep it and mark the blank region as the defect. If it is blank because loading was too slow or the capture was wrong, retry and keep the retry record.

## Marking Rules

Use a consistent color language:

| Color | Meaning |
|-------|---------|
| Red | P0 blocker: blank body, crash, core flow unusable |
| Orange | P1/P2 risk: visible interference, layout break, unstable or incomplete behavior |
| Blue | Environment, path, or data reachability: route reachable, top bar visible, API returned |
| Green | Passing evidence: expected content or interaction is visible and usable |

Labels must include severity and phenomenon, such as `P0: 正文区域空白` or `通过: 主体列表可见`. Do not write vague labels such as `异常`, `有问题`, or `正常`.

## Verdict Rules

- `pass`: all required PR/commit claims have valid evidence and no blocking defect remains.
- `conditional`: key evidence exists, but non-blocking risk, environment instability, or partial coverage remains.
- `fail`: any P0 exists, the target SHA was not actually tested, MAP report verification fails, or critical PR/commit claims lack evidence.

The top verdict must match the worst meaningful mapped result. Do not mark the whole report as passed when one target commit has a failed runtime claim.
