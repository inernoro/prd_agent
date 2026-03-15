---
globs: ["prd-api/src/**/*.cs"]
---

# 应用身份隔离原则

每个应用必须有独立的 Controller 层，Controller 中硬编码 `appKey`，不由前端传递。

## 规则

1. 每个应用必须有自己的 Controller，硬编码 `appKey`
2. `appKey` 使用 `kebab-case` 格式
3. 后台管理接口使用 `/api/{module}` 格式，禁止 `/v1/` 版本号
4. 即使多个应用调用相同底层服务，也要通过不同 Controller 入口

## 已定义应用标识

| appKey | 应用 |
|--------|------|
| `literary-agent` | 文学创作 |
| `visual-agent` | 视觉创作 |
| `prd-agent` | PRD 解读 |
| `defect-agent` | 缺陷管理 |
| `video-agent` | 视频生成 |
| `report-agent` | 周报管理 |

## 水印配置

水印配置基于 `appKey` 绑定，只有绑定了特定 appKey 的应用才会应用对应的水印配置。
