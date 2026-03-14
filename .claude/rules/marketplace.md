---
globs: ["prd-admin/src/lib/marketplaceTypes.tsx", "prd-api/src/**/IMarketplaceItem.cs", "prd-api/src/**/ForkService.cs", "prd-api/src/**/IForkable.cs"]
---

# 海鲜市场 (Configuration Marketplace) 扩展指南

当需要将新的配置类型发布到海鲜市场时参考。

## 核心文件

| 文件 | 用途 |
|------|------|
| `prd-admin/src/lib/marketplaceTypes.tsx` | 前端类型注册表 + 预览渲染器 |
| `prd-admin/src/components/marketplace/MarketplaceCard.tsx` | 通用卡片组件 |
| `prd-api/src/PrdAgent.Core/Interfaces/IMarketplaceItem.cs` | `IMarketplaceItem` + `IForkable` 接口 |
| `prd-api/src/PrdAgent.Infrastructure/Services/ForkService.cs` | 通用 Fork 服务 |

## 添加新类型步骤

1. 前端：在 `CONFIG_TYPE_REGISTRY` 注册类型（key, label, icon, color, api, PreviewRenderer）
2. 前端：实现 `PreviewRenderer` 组件
3. 后端：Model 类实现 `IForkable` 接口（`GetCopyableFields()` 白名单 + `OnForked()` 处理）
4. 后端：添加 marketplace/publish/fork API 端点

## 已注册类型

| 类型 Key | 标签 | 数据源集合 |
|----------|------|-----------|
| `prompt` | 提示词 | `literary_prompts` |
| `refImage` | 参考图 | `reference_image_configs` |
| `watermark` | 水印 | `watermark_configs` |

## 设计原则

- `CONFIG_TYPE_REGISTRY` 统一注册，卡片渲染自动适配
- `GetCopyableFields()` 白名单复制，避免复制敏感信息
- `IMarketplaceItem` 定义公共字段（ForkCount、IsPublic 等）

> 详细设计：`doc/spec.marketplace.md`
