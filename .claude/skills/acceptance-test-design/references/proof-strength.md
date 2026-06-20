# Proof Strength Model

## Evidence Strength Levels

| Score | Name | Meaning | Can support pass? |
|-------|------|---------|-------------------|
| 0 | 无关 | Same project or module, but not the changed behavior | No |
| 1 | 入口 | Page, route, button, or list is reachable | Only for entry/navigation changes |
| 2 | 弱相关 | Nearby state suggests the feature exists, but the changed path was not exercised | No for deep acceptance |
| 3 | 行为相关 | User action produces the expected visible result or failure | Yes |
| 4 | 闭环证明 | User action, visible result, persisted/API/log state, and negative or boundary path all align | Strong pass |

Daily or PR deep acceptance should prefer score 3 or 4 evidence. Score 1 or 2 can appear in a report only as entry evidence, context, or a known gap.

## Page-First Rule

For user-facing changes, the primary proof is visible product behavior:

- the page or breadcrumb where the user experiences the change
- the action that triggers it
- the expected result on screen
- the failure symptom if it does not work

Internal data is secondary:

- API response
- logs
- database row
- background job state
- generated file
- command output

Use internal data to explain why the page result is trustworthy, persisted, or broken. Do not use internal data to hide the absence of page proof.

## Weak-Proof Traps

Reject these as pass evidence unless the assertion itself is about that exact surface:

- `列表可见`
- `页面可达`
- `按钮可见`
- `接口 200`
- `数据库有记录`
- `日志有输出`
- `页面标题正确`
- `同模块截图`
- `看起来加载了`

Each can become useful only after the changed action and result are tied to it.

## Falsifiability Check

For every proof, write:

| Field | Question |
|-------|----------|
| Expected visible result | What must the user see? |
| Expected internal result | What state should corroborate it? |
| Failure condition | What observation would make this fail? |
| Drift condition | What would make the evidence irrelevant, such as wrong SHA or wrong branch? |

If the proof cannot fail, it is not a test.
