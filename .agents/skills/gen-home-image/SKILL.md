---
name: gen-home-image
description: 扫描并补齐 MAP 百宝箱首页卡片的浅色与深色主题图片，统一注册主题素材、验证全覆盖，并安全发布测试环境与正式环境。用户要求新增、补全、重做首页或百宝箱图片，检查图片背景未铺满，或发布明暗主题素材时使用。
---

# Gen Home Image

为 `prd-admin` 百宝箱生成成对的明暗主题卡片图，并把“有没有漏”从人工记忆改为可失败的资源审计。流程借鉴 durable workflow：每阶段都可独立重跑，审计结果就是检查点。

## 强制流程

1. 确认工作树、当前分支和 `origin/main` 状态。不要在含不明用户改动的文件上直接覆盖。
2. 从仓库根目录运行 `pnpm --prefix prd-admin run theme:audit`。只为审计报告中的缺失 `agentKey` 工作；不要使用固定数量作为完成标准。
3. 阅读 `prd-admin/src/stores/toolboxStore.ts` 中目标条目的名称、说明和职责，再读取 [prompts.md](references/prompts.md)。
4. 使用内置 `imagegen` 先生成浅色图。以现有 `visual-agent-light.webp` 为风格参考，背景必须铺满四角，主体位于中央 78% 安全区，不生成文字、Logo、UI 截图或水印。
5. 使用刚生成的浅色图作为第一参考、`visual-agent.webp` 作为第二参考生成深色图。必须锁定构图，只改变光照、材质、明暗与少量荧光绿点缀。
6. 将图片规格化为 `960x600` WebP，质量 84：

   ```bash
   magick INPUT -resize '960x600^' -gravity center -extent 960x600 -quality 84 OUTPUT.webp
   ```

   输出到 `prd-admin/src/assets/agent-card-art/<agentKey>-light.webp` 与 `<agentKey>.webp`。不得删除 imagegen 原始文件，也不得无请求覆盖已有成对资源。
7. 同步更新 `AgentCardArtwork.tsx` 的职责说明、`tokens.css` 的深浅主题 token，以及依赖注册表推导覆盖率的测试；禁止新增固定总数断言。
8. 运行 `pnpm --prefix prd-admin run theme:check` 和生产构建。该命令同时执行资源注册审计、动态入口覆盖率、语义 token 与 WCAG AA 对比度契约；不得跳过其中任一层。
9. 建立明暗 contact sheet，在卡片缩略尺寸检查四角铺满、主题匹配、文字安全区、主体辨识度和跨卡片一致性。
10. 按 [release-flow.md](references/release-flow.md) 发布。测试环境可以在验证通过后自动发布；正式环境必须先明确展示项目、分支、不可变提交 SHA 和回滚点，并取得用户确认。

## 失败恢复

- 生成中断：重跑审计，只生成仍缺失的 key。
- 只有一张主题图：保留现有图，以其为构图参考补另一张。
- 注册或构建失败：不要重新生成图片；修正契约后重跑审计。
- 测试环境失败：停止正式发布，保留分支与不可变提交用于排查。
- 正式验证失败：停止后续动作，按发布说明回滚到记录的上一个健康 SHA。

## 完成标准

- `BUILTIN_TOOLS` 每个唯一 `agentKey` 都有展示元数据、两个主题 token 和两张 `960x600` WebP。
- 浅色卡不再使用暗图洗白；深色卡不从浅图套滤镜。
- 主题审计、定向测试、TypeScript 与生产构建全部通过。
- 测试环境深链 `/ai-toolbox` 的明暗主题都经过真实浏览器验证。
- 正式环境只有在确认门之后发布，并验证 HTML、静态资源与 `/ai-toolbox` 深链。
