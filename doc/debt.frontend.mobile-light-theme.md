# 移动端全局浅色主题 · 债务台账

> **版本**：v1.0 | **日期**：2026-07-12 | **状态**：开发中

## 背景

2026-07-12 移动首页定稿浅色为默认（`mobileThemeStore`，浅/暗可切换），AppShell 在移动端
按偏好把 `<html data-theme="light">` 全局落下（按路由重申）。壳层（顶栏 / MobileTabBar /
快速创建抽屉）与走 `tokens.css` token 的页面已随之变白；但站内存在大量**硬编码暗色**的页面
（inline `rgba(255,255,255,x)` 表面、`#0f1014` 类底色），这些页面在浅色偏好下仍呈暗色或出现
「暗卡浮在白底」的混搭。

## 债务清单

| # | 事项 | 影响 | 建议 |
|---|---|---|---|
| 1 | 移动端各页面硬编码暗色清理 | 浅色偏好下 `/visual-agent`、`/defect-agent`、`/ai-toolbox` 等页面局部或整页仍是暗色 | 按页面逐个把 inline 暗色换成 token（`--bg-*`/`--text-*`）或双主题分支；优先 TabBar 五入口页（首页/浏览/知识库/我的） |
| 2 | 桌面端不受 mobileThemeStore 影响 | 桌面仍是既有暗色体系；同账号手机浅色、桌面暗色属有意设计 | 若未来桌面也要浅色默认，另行评估 tokens.css 全站覆盖度 |
| 3 | report/daily-post 自管 data-theme 与全局偏好的竞态 | 暗色偏好下进入这些页强制变浅（纸面身份），退出后由 AppShell 按路由重申恢复 | 现机制可用；若出现闪烁再收敛为「页面声明式主题请求 + 壳层仲裁」 |
| 4 | 首页宫格 tint 底在暗色形态下的层次 | 暗色形态图标块为中性底 + 彩色线稿，用户若觉得素可加低饱和 tint 底 | 待用户反馈决定 |

## 系统级机制（2026-07-12 晚落地，本台账从「逐页救火」转为「棘轮清偿」）

- 守卫：`prd-admin/src/lib/__tests__/themeHardcodeRatchet.test.ts` —— 每文件白透明/深色 hex
  计数只减不增，基线 `themeHardcodeBaseline.json`（首次量化：362 文件 / 2856 白透明 / 562 深色 hex）
- 规则：`.claude/rules/admin-dual-theme.md`（修法映射表 + 基线更新流程）
- 已清偿：海鲜市场半高/迷你密度卡（用户截图病灶）、底部 TabBar、快速创建抽屉、
  百宝箱移动版（AS_COLOR_LIGHT + useAppStoreColors）、我的/通知页

## 已完成（本轮）

- `mobileThemeStore`（localStorage 持久化，浅色默认）+ 首页右上角明暗切换按钮
- AppShell 移动端按 `mode + pathname` 重申 `data-theme`
- MobileTabBar 与快速创建抽屉双主题化（浅色白底墨字）
- 首页 / 米多早报滚动容器隐藏滚动条（`.no-scrollbar`）
