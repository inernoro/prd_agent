| refactor | cds | P3 Part 1：抽出 `StateBackingStore` 接口 + `JsonStateBackingStore` 实现，把 `StateService` 的 atomic write / `.bak.*` rotation / recovery 逻辑从 `state.ts` 搬到独立模块；`StateService` 改为通过 `backingStore.load()/save()` 委托持久化。为 P3 Part 2 接入 MongoDB 准备接缝 |
| feat | cds | 新增 `CDS_STORAGE_MODE` 环境变量（默认 `json`）。`mongo`/`dual` 值会在启动时抛出明确错误指向 Part 2/3，避免 .cds.env 误配置静默降级 |
| test | cds | 新增 `tests/infra/json-backing-store.test.ts` 9 条单测直测 backing store，全量测试 331 → 340 零回归 |
