# 缺陷管理 · 手机截图分享提交 债务台账

> **版本**：v1.0 | **日期**：2026-07-10 | **状态**：首版已落地（PWA share_target + VLM 自动填充 + 移动全屏面板），下面为主动声明的已知边界
> **关联变更**：分支 `claude/map-screenshot-bug-submit-p6lmd4`（prd-admin：manifest.webmanifest / sw.js / defectDeepLink `?action=submit` / DefectSubmitPanel 移动布局与 AI 追加填充）

记录「手机截图 → 系统分享 → 拉起缺陷提交面板 → VLM 自动填充」首版的已知边界与后续可补项，避免下一次 session 没人记得。

## 一、已落地

- PWA manifest + 最小 service worker（只当 share_target 收件箱，零静态资源缓存，无发版旧缓存风险）。
- Android Chrome/Edge：安装 PWA 后系统分享菜单可把截图分享给 MAP，经 `POST /share-defect` 暂存 → 303 落 `/defect-agent?action=submit&shared=1` 自动拉起提交面板并带入截图。
- VLM 识别结果以「【AI 截图识别】」标签块**追加**进问题描述（空内容时首句自动成标题行），只追加不覆盖、去重，不锁输入框。
- 提交面板移动端全屏布局（选择器纵向堆叠、密度收紧、safe-area 兜底）。

## 二、已知边界（诚实记录）

| 边界 | 说明 |
|------|------|
| iOS Safari 不支持 share_target | W3C share_target 目前 iOS 不实现。iPhone 路径 = 打开 MAP → 缺陷页「提交」→ 附件按钮走相册/拍照，或长按粘贴截图。功能不缺失，只是少了系统分享入口。 |
| 需要先安装 PWA | share_target 只在「添加到主屏幕」后出现于分享菜单。当前无安装引导 UI（beforeinstallprompt 提示条可后补）。 |
| PWA 冷启需重新登录 | 认证态按规范存 sessionStorage（`no-localstorage.md` 红线），PWA 每次冷启 session 为空 → 先落登录页；`returnUrl` 保留 `?action=submit&shared=1`，登录后仍能回到带图面板（截图暂存于 Cache Storage，不受登录跳转影响）。 |
| GlobalDefectSubmitDialog 未接自动填充 | 全局 Cmd+B 弹窗与页面内 DefectSubmitPanel 高度重复（历史债），本次只给后者接了 AI 追加填充与移动布局。两面板合并/抽公共逻辑时一并处理。 |
| VLM 未配置时静默降级 | 模型池无 vision 模型时返回 `MODEL_NOT_CONFIGURED`，截图仍可作为附件提交，仅无自动填充（与桌面既有行为一致）。 |
| 分享暂存为一次性 | 截图领取即从 Cache Storage 删除；用户拉起面板后放弃提交则分享的图随之丢弃，需重新分享。 |

## 三、后续可补

1. `beforeinstallprompt` 安装引导（手机端缺陷页顶部提示条「安装到桌面，截图一键报缺陷」）。
2. 两套提交面板（DefectSubmitPanel / GlobalDefectSubmitDialog）抽公共逻辑，AI 填充与移动布局收敛到一份。
3. share_target 的 `text/url` 字段目前只原样追加进描述，可考虑喂给 polish 一起润色。
4. 缺陷页教程 `defect-page-guide` 可补一步「手机截图分享直达提交」的更新提醒（`*-update-reminder`）。
