# 快捷指令 Agent · 债务台账

> **版本**：v1.0 | **日期**：2026-06-15 | **状态**：维护中

## 总览

| 指标 | 当前值 |
|------|--------|
| open | 3 |
| in-progress | 0 |
| paid | 0 |

模块范围：`prd-api/src/PrdAgent.Api/Controllers/ShortcutsController.cs`、
`prd-admin/src/pages/shortcuts-agent/`（`ShortcutsPage.tsx` 管理 + `ShortcutInstallPage.tsx` 扫码安装公开页）、
`prd-api/src/PrdAgent.Infrastructure/Services/ShortcutPlistGenerator.cs`、`lib/clipboard.ts`。

---

## 背景

2026-06-15 用户反馈快捷指令"每次都特别不好用、复制不到剪贴板"，并要求"让用户扫码变得最无脑"。
本轮已偿还前端可修的部分（见下方「已修」），但有几处**根因在环境/运维或后端**，前端只能改善体感、无法消除，记此台账留痕。

---

## open（已知边界，待后续偿还）

### O1. 真正的"一键安装"依赖前置条件，前端无法替代（最高优先）

iOS 安装 `.shortcut` 的可靠路径只有两条，二者都不在前端控制范围内：

| 路径 | 前置条件 | 现状 |
|------|---------|------|
| 服务端签名直出 | 服务端跑在 **macOS** 且 `/usr/bin/shortcuts` 可用 + `Shortcuts:EnableLocalSigning` | 生产多为 Linux 容器，`CanSignShortcutFiles()` 恒 false |
| iCloud 模板 | 管理员先在 Mac 上装模板 → 分享拿 iCloud 链接 → 后台 `POST admin/templates` 配好 | 默认未配，需人工一次性操作 |

两者都没配时，用户扫码后落到**纯手动新建快捷指令**（搜索"获取 URL 内容"、填 URL/POST/请求体/头部），这条路天然不"无脑"。

**可能的偿还方向**：服务端托管一个**公共 iCloud 模板链接**（官方建一次、所有部署共用，免去每个站点自己上传），或提供一台 macOS 签名 worker。需后端 + 一次性运维准备，未排期。

### O2. 智能体绑定（BindingType=Agent）是 Phase 2 占位，未真正路由

`ShortcutsController.Collect` 中 `ShortcutBindingType.Agent` 分支只改了返回文案
（"智能体 X 正在处理…"），实际 `// TODO: Phase 2 - 路由到对应智能体` 未实现。
绑定智能体的快捷指令目前等价于"仅收藏 + 一句假装在处理的提示"。

**偿还方向**：把收藏内容真正投递到对应 agent 的入口（参考 workflow 分支的 `WorkflowExecution` 写法）。

### O3. 签名直出运行时失败会让用户看到原始 JSON

`canDownloadSigned=true` 时安装页用 `<a href={downloadUrl}>` 直接导航；若 `/download` 运行时
签名失败（超时/exit≠0）返回 409 JSON，浏览器会渲染成裸 JSON 错误页。未改是因为换成
fetch+blob 有破坏 iOS "添加快捷指令"系统交接的风险，需真机验证后再动。当前靠同屏的
"复制 iCloud 模板配置"次按钮兜底。

**偿还方向**：真机验证 blob 下载是否仍能触发 iOS add-shortcut；可行则改 fetch + 409 友好降级。

---

## 已修（2026-06-15，本轮）

- 剪贴板假成功：新增 `lib/clipboard.ts`（async API + execCommand 兜底 + 真实成功布尔），
  安装页/二维码面板复制改为诚实反馈（成功/失败 toast），不再"按钮变绿但剪贴板为空"。
- 安装页报错读错字段（恒显示"加载失败"）→ 按 `error.code` 分流（过期/失效/已删除/网络）+ 下一步 + 重试。
- 新增"连接自检"：装完点一下走 `GET /collections`（带 token，非破坏性）当场验证密钥是否打通。
- 新增"遇到问题"FAQ（iOS 15+/不受信任/分享表单/网络权限）。
- 纯手动兜底场景：诚实友好提示 + 补全手动步骤（请求体/头部/自检收尾）。
- iCloud 模板配置面板：增加"不配=全员手动、配好=全站一键"的影响说明，促使一次性配好。

---

## 相关

- `.claude/rules/zero-friction-input.md` / `chief-designer-usability.md` —— 体验底线
- `doc/guide.shortcuts-agent.md` —— 用户使用指南
- `doc/design.shortcuts-agent.apple.md` —— 设计文档
