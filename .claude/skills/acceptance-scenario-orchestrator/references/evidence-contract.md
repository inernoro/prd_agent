# Evidence Contract

Every acceptance report must let the reader audit how the conclusion was reached.

## Required Chain

Each test unit must connect:

`PR/commit -> module -> page breadcrumb -> expected result -> actual evidence -> conclusion`

Rules:
- If a link in the chain is unknown, write `未知` and mark the unit as not fully accepted.
- If a screenshot proves a claim, the claim must be visible in the screenshot or the screenshot is invalid.
- If API/log/file evidence proves a non-visual claim, show the exact endpoint, file, or command output summary.
- If the tested environment SHA differs from the target SHA, the test cannot pass for that PR or commit.

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
