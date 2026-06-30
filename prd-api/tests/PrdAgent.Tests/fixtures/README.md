# LLM 解析黄金基准（全量回归底片）

`llm-resolution-golden.main.json` 是"模型池解析行为"的全量回归基准 —— 注册表全部 153 个 `AppCallerCode` 在 **live `main`** 上的真实解析结果快照（2026-06-25 采集）。

## 用途

P1 协议下沉重构的安全网。重构前后各跑一次解析，与本基准逐行 diff：

- 全一致 → 证明"内部重构、对外行为零变化"（P1 目标）。
- 任一行变 → 精确指出哪个 `AppCallerCode` 的解析被意外改动。

详见 `doc/design.llm-gateway-unification.md` §11 测试策略。

## 字段

每条 = 一个 code 的解析结果：`code` / `resolutionType`(DedicatedPool/DefaultPool/Legacy/NotFound) / `actualModel` / `platformType` / `apiUrl` / `modelGroupId` / `isFallback` / `healthStatus`。不含任何密钥。

## 采集方式（可复现）

`GET /api/open-platform/app-callers/resolve-model?appCallerCode={code}&modelType={::后缀}`，
带 `X-AI-Access-Key` + `X-AI-Impersonate`，对注册表 `grep` 出的 153 个 code 逐个解析。

## 重要：这是"live main"快照，不是单测黄金值本身

P1 落地时，配套的 xUnit 黄金快照单测会用**种子 fixture**（mock Mongo）重建解析，产出自己的内部黄金值。本文件是**交叉校验基准** + P0 取证证据：单测覆盖的 code 的解析结论应与此一致。
