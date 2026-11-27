---
name: map-agent
description: 通过已经连接的 MAP MCP 操作知识库、创作、技能市场和网页托管；用于安装或更新 MAP 配套技能、原样上传网站、修改分享权限及检查交付结果。
metadata:
  version: "1.3.0"
---

# MAP 智能体接入与托管

开始前查看当前连接的 MAP 工具清单，以工具清单和真实接口返回为准。网页托管使用一个授权。Agent 可以在账号可管理的站点中上传、更新、公开、分享和删除。

## 连接与技能维护

连接来自 MAP 的“智能体接入台”。Codex 使用接入台提供的 TOML 配置；WorkBuddy 使用接入台提供的 `streamableHttp` 配置及其技能 ZIP 导入入口。连接配置含私人密钥，公开下载的技能包不含密钥；不得把配置或密钥写入项目、截图、报告或公开日志。

Codex 技能安装到项目的 `.agents/skills`；安装时显式传 `--client codex`，项目即使只有 `.claude` 也会创建 `.agents`，同时维护已有宿主。默认未指定客户端时，存在 `.claude`、`.agents` 就各装一份；两者均不存在时使用 `.agents/skills`。不要改写用户主目录或创建第三套宿主目录。WorkBuddy 通过自己的“添加技能”导入下载的 ZIP，不以目录里存在文件宣称 WorkBuddy 已识别。

安装器只需 Python 3 标准库。从接入台提供的 manifest 地址取得最新版，首次下载安装器后运行：

```bash
python3 map-agent-installer.py install --manifest-url '<接入台提供的 manifestUrl>' --project . --client codex
```

检查和更新已有安装：

```bash
python3 .agents/skills/map-agent/scripts/skill_manager.py check --project . --client codex
python3 .agents/skills/map-agent/scripts/skill_manager.py update --project . --client codex
```

只使用 Claude Code 的项目可改用 `.claude` 路径和 `--client claude`。安装记录保存来源、版本和文件摘要；`check` 不改文件，输出每个宿主的已装版本、线上版本、本地修改及是否可更新。`update` 校验下载包并替换完整技能目录。本地修改或非安装器管理的同名目录会阻止覆盖；保留这些文件后重新处理，不要用强制删除解决。更新之后重载技能或新开对话，并实际调用一次 MAP 工具；仅下载成功不等于宿主已加载。

WorkBuddy 更新时在接入台查看当前版本，对照 WorkBuddy 已安装技能详情中的版本；下载新版 WorkBuddy 专用 ZIP 后通过 WorkBuddy 的技能管理重新导入，再新开对话调用。网页无法读取本机已安装版本，不能据网页版本号宣称已更新。项目安装器只维护项目中的 Codex / Claude 技能副本，不代替 WorkBuddy 的导入。

## 使用 MAP 能力

- 知识库：先列库与条目再读正文；更新前读回版本令牌，传回 `expectedUpdatedAt`，冲突后重读而不是覆盖别人修改。
- 视觉创作：先确认模型能力；生图取得 `runId` 后按工具说明查询进度，直到明确成功或失败。
- 文学创作：先读工作区；配图修改遵循返回的 `workflowVersion`、标记索引与历史记录，不以重建整篇代替指定位置修改。
- 技能市场：搜索、看详情、下载公开技能免凭据。优先复用市场现有技能；安装其它技能遵循其包内容和宿主约定。
- 网页托管：操作前读取当前站点或上传指引，按下方流程保留用户的原始产物。

长任务持续报告正在做的阶段与真实返回进度。单次等待按工具给出的轮询间隔查询，不无限重试失败请求；报告失败原因与可采取的下一步。

## 网站与访问权限

用户给 ZIP 时，其目标通常是原样托管。多页面、相对链接、图片、样式、脚本和目录结构必须保留；不能把 ZIP 重写或拼成单页 HTML 当作完成。图片上传也不要转成模型重绘。

每次网页写入生成一个新的 `clientRequestId`，同一次操作重试用相同值。MCP 写入工具声明该参数时传在工具参数里，multipart 上传则传在表单里。

1. 更新原站前，用 `map_web_get_page_settings` 读回当前状态和 `externalAccess`，确认操作目标。私有站点也可能已有公开分享。
2. 用 `map_web_get_upload_info` 取上传地址、限制及短时 `uploadToken`。更新原站时传原 `siteId`。把原文件作为 multipart 的 `file` 字段发送，在 `Authorization: Bearer` 请求头中传上传凭证。用 `map_web_get_upload_progress` 查询进度。
3. 上传或更新后用同一个 `siteId` 调 `map_web_get_page` 核对文件、入口和版本。更新原站后重新打开原分享链接执行下方浏览器检查。
4. 用 `map_web_get_organization` 查看文件夹和标签，`map_web_update_page` 修改元数据，`map_web_set_comments_enabled` 管理评论，`map_web_delete_page` 删除账号可管理的站点。
5. 用 `map_web_set_visibility` 按用户要求设置站点公开或私有。若 MAP 返回引用了其他私有资料，依据响应处理来源授权及对应资料指纹。
6. `map_web_create_share` / `map_web_update_share` 的 `expiresInDays=0` 表示永久。`public` 表示匿名公开，`logged-in` 表示需登录，`owner-only` 表示本人及团队。用 `map_web_list_shares` 读回分享范围、到期和状态，需要撤回时用 `map_web_revoke_share`。将站点改为私有后检查现存分享的访问范围。

## 网页托管的浏览器检查

- 独立单页 HTML 可用 `map_web_publish_page`。多文件网站用 `map_web_get_upload_info` 返回的 ZIP 上传入口，保留相对目录和依赖。上传前记录首页入口和首屏必需资源，例如目录 JSON、模块脚本、媒体、子页面和下载依赖。自有成品优先在现有私有预览或获准的候选版本中检查；用户交来的原样托管包发现兼容问题时，保留原件，按授权范围处理。
- 在浏览器实际打开用户要用的 MAP 预览或分享链接，按交付身份走到关键结果。检查动态目录或正文已经填充，打开一项代表性的子页面或脚本交互，并按站点实际能力抽查图片、视频或下载。保留入口、版本和断言结果。公开链接用未登录浏览器，私有或团队链接用具备对应权限的账号。替换同一站点后重新打开原分享，确认读到新版本且主路径仍可走通。
- 首页外观正常而正文为空时，对照托管原始入口与 MAP 内嵌入口。依据浏览器和真实响应检查 iframe 的 `src` / `srcdoc`、沙盒来源、计算出的请求路径、状态、响应类型及 CORS。JSON 请求直接访问得到 200，仍可能被空来源的沙盒拦截。已获准调整自有产物时，按实际嵌入模式消除首屏对受限请求的依赖，或使用平台支持的独立托管预览，再重走原入口。保持原有来源隔离和访问权限。
- 交付说明写明文件与版本读回、浏览器检查结果、实际分享范围和到期时间。浏览器未验证时写明「浏览器访问未验证」。原入口仍失败时保留失败证据，通过已获准且亲测有效的入口止血，并明确原入口状态。用户要求公开永久时须读回 `visibility=public` 且无到期时间。撤销后实际验证旧链接被拒。

若当前连接的工具与本文不一致，用 MAP 实际提供的入口继续执行，并说明兼容情况。交付的分享范围和到期时间按用户要求设置。
