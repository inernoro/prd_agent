# Fusion Testing

Fusion testing means one realistic scenario proves multiple related assertions without reducing proof quality.

## When To Fuse

Fuse tests when assertions share a real user journey, such as:

- upload -> compression -> preview -> persisted result
- create run -> worker state -> result page -> retry/failure display
- permission boundary -> disabled action -> API rejection
- sync trigger -> progress state -> log/result row -> shared view
- branch preview -> navigation -> feature result -> error handling

Do not fuse unrelated changes just to reduce screenshot count.

## Fusion Scenario Template

| Field | Content |
|-------|---------|
| Scenario name | A real user task, not a file name |
| Covered assertions | Commit/PR assertions covered by this scenario |
| User path | Breadcrumb and step sequence |
| Primary page proof | The visible state that proves the scenario |
| Internal corroboration | API/log/state needed after the page proof |
| Negative/boundary path | What invalid, unauthorized, slow, empty, duplicate, or retry case is tested |
| Proof density | How many assertions are covered and why the evidence is still direct |
| Risk of over-fusion | What might be hidden if the scenario is too broad |

## Coverage Budget

Do not use a fixed screenshot cap. Use this budget:

| Risk | Evidence expectation |
|------|----------------------|
| Low visual copy/layout | 1 result screenshot plus readback may be enough |
| Normal user workflow | action screenshot plus result screenshot |
| High-risk runtime | user path screenshot plus result/API/log evidence plus one negative path |
| Auth/security/state transition | positive and negative path; page and internal corroboration |
| Async/background/external integration | page state, worker/run state, retry or failure observation, and persisted result when safe |

If the budget is too large for the run, downgrade to `广度冒烟` and list the missing deep-acceptance items.

## Anti-Patterns

- Ten images and stop, even though high-risk assertions remain untested.
- One generic dashboard screenshot claimed to cover many commits.
- API-only fusion where no user path is exercised.
- Fusion that covers file proximity instead of behavior proximity.
- Removing negative paths because the happy path looked correct.
