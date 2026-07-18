# 前端 Apple 设计系统迁移 · 计划

> **版本**：v2.0 | **日期**：2026-07-17 | **状态**：规划中

## 目标

让移动端和 PC 后台共享字体、系统色、状态色和交互原语，同时保留品牌页、画布和刊系页面的明确例外。移动端以 App Store 风格 token 为权威，PC 只统一底座，不重排现有信息架构。

## 已定决策

- PC 和移动端强调色统一为 iOS 系统蓝，不再维护金色主强调分支。
- 后台正文和内页使用 SF-first 字体栈；landing 与 hero 可保留品牌展示字体。
- 移动端暗色背景使用纯黑；浅色必须由同一语义 token 映射，禁止页面自建第二套色板。
- 动态状态色、数据可视化、图片内容和刊系纸面页面可以保留受控例外，但必须注明原因。

## 已落地底座

- `appStore.tsx`、MobileBottomSheet、移动首页、资产、个人页和通知页已有双主题迁移。
- 移动首页已采用“继续上次、常用、近七日、动态、档案”的摘要结构。
- 玻璃 TabBar、核心移动原语和部分 token 已对齐系统蓝。

以上完成事实不再逐组件记录；后续以代码、主题棘轮和视觉证据为准。

## P1：移动端收尾

1. `MobileToolboxView` 的字号、间距、圆角和 accent 全部改用现有 AS token。
2. `MobileVisualAgentEditor` 接入双主题 token，移除固定暗色背景和硬编码强调色。
3. Fab、OverflowMenu、CompatGate、Segmented 等共享 chrome 补齐双主题。
4. 所有一级移动页验证浅色、暗色、安全区、键盘、底部导航和长内容滚动。

## P2：PC 设计底座

- 在 `tokens.css` 建立唯一 `--ios-*` 系统色语义层，并补齐暗色与浅色状态 token。
- `--font-body` 调整为 SF-first，`base.css` 提供全局兜底。
- focus、accent、canvas 状态色和 design 原语使用语义 token，不直接写平台色值。
- Button、PageHeader、SegmentedTabs、KpiCard 和圆角来源统一；不改变页面布局。

## P3：硬编码清扫

顺序固定为：AppShell 与 design 原语、CdsAgent、Changelog、InfraServices，再到高频业务页。每次只改一个可验收范围，主题硬编码棘轮只减不增。

library、md-to-ppt、首页品牌页、DailyPost 和复杂画布先判断是否属于内容、数据或品牌例外；不能因为扫描命中就机械替换。

## 验收门

1. 双主题下正文、边框、面板、输入、弹层和状态色均可读，无固定暗底泄漏。
2. 移动端键盘、safe area、底部导航和 sheet 不遮挡主操作。
3. PC 页面布局与交互路径不因 token 迁移改变。
4. `themeHardcodeRatchet` 基线只下降；确需例外时记录文件、语义和原因。
5. `prefers-reduced-motion`、焦点可见性和对比度通过检查。

## 关联文档

- `doc/plan.frontend.mobile-adaptation.md`
- `.claude/rules/admin-dual-theme.md`
- `.claude/rules/full-height-layout.md`
