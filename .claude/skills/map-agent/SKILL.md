---
name: map-agent
description: 通过已经连接的 MAP MCP 操作知识库、创作、技能市场和网页托管；用于安装或更新 MAP 配套技能、原样上传网站、修改分享权限及检查交付结果。
metadata:
  version: "1.1.0"
---

# MAP 智能体接入与托管

先查看当前连接的 MAP 工具清单；工具清单和真实接口返回是能力依据。不要假设同一账号在网页上能做的事已经全部开放给 MCP。遇到缺口要说“当前 MCP 未开放此操作”，不要说 MAP 整个平台不支持。

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

1. 更新原站时，在渲染或打包前先用 `map_web_get_page_settings` 检查 `externalAccess` 和 `canUpdateContent`。已有访问链接的私有站点也可能对外。旧服务没有这项工具时，可调用 `map_web_get_upload_info(siteId)` 做预检，提交前按需重新取短期凭证。
2. 更新对外内容前，请用户确认更新的站点和影响范围，提供「更新对外原站」「另存私有副本」「先不更新」中当前可执行的选项。缺少客户端发布授权时，说明原站更新尚未提交，并提供私有副本或暂缓的选择。用户明确要持续委托这台客户端时，再提供接入台的授权入口。
3. 用 `map_web_get_upload_info` 取上传地址、限制及短时 `uploadToken`。更新时传 `siteId`，已确认对外更新时加 `confirmedExposure=true`。把原文件作为 multipart 的 `file` 发送，同时附带服务返回的 `requiredAdditionalFormFields`。上传凭证放在 `Authorization: Bearer` 请求头，只用于该次上传，避免写入日志或 URL。上传进度用 `map_web_get_upload_progress` 查询。
4. 更新后用同一个 `siteId` 调 `map_web_get_page` 读回资源、状态和版本；把回执的 `managementUrl` 提供给用户用于定位站点。渲染完成、服务已接收文件和原站已更新分别报告，只有成功回执读回后才报告完成。
5. `map_web_get_organization` 列出文件夹和标签，`map_web_update_page` 修改对应元数据，`map_web_set_comments_enabled` 管理评论。对外更新标题或描述、对外开启评论均需发布授权和本次确认。
6. `map_web_set_visibility` 管理站点的 private / public 状态，分享链接有独立的访问范围。升为公开或登录可见之前，明确让用户选择范围，再带 `confirmedExposure=true`。服务要求私有资料确认时，先展示具体来源，取得确认后提交对应指纹。
7. `map_web_create_share` / `map_web_update_share` 的 `expiresInDays=0` 表示永久；`public` 表示匿名公开，`logged-in` 表示需登录，`owner-only` 表示本人及团队。用 `map_web_list_shares` 读回分享范围、到期和状态，需要收回时用 `map_web_revoke_share`。将站点改为私有后也要检查仍有效的分享链接。

交付时分别说明：原文件是否保留、站点是否更新、返回的分享范围和到期时间、实际打开验证结果。用户要求“公开永久”时，应明确看到 `visibility=public`、无到期时间，并以未登录浏览器打开实际分享链接。检查至少一个子页面跳转、一个图片、一项脚本交互。撤销后再验证旧链接被拒。只有接口返回成功时，写“接口已设置，浏览器访问未验证”，不要写“验收通过”。

若当前工具清单缺少上述工具，停止在该边界，说明具体缺少哪一步；可以引导到 MAP 已有的网页入口。不要以本人及团队可见或 90 天链接替代用户明确要求的公开永久链接。
