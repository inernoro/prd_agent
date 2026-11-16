---
name: map-agent
description: 通过已经连接的 MAP MCP 操作知识库、创作、技能市场和网页托管；用于安装或更新 MAP 配套技能、原样上传网站、修改分享权限及检查交付结果。
metadata:
  version: "1.0.0"
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

1. 用 `map_web_get_upload_info` 取上传地址、字段、限制及短时 `uploadToken`；更新时传 `siteId` 取得该站点的上传入口。通过本地文件工具或 HTTP 客户端把原文件作为 multipart 的 `file` 发送，并把返回的 `uploadToken` 放进 `Authorization: Bearer` 请求头。令牌只用于该次上传，不打印、不写日志、不放 URL；不要索要或复制客户端的长效密钥，也不要把 ZIP 编成 base64 塞进 MCP 对话。上传进度用 `map_web_get_upload_progress` 查询。
2. 用返回的 `siteId` 调 `map_web_get_page` 读回资源和当前状态。更新已有站点使用指引返回的重传地址，保留同一个站点标识；不要每次新建。
3. 元数据修改使用 `map_web_update_page`；站点可见性使用 `map_web_set_visibility`。仅在用户已明确要求公开后传 `confirmedExposure=true`。服务若要求私有资料确认，先展示具体来源，再按用户的明确选择提交返回的指纹。
4. `map_web_create_share` / `map_web_update_share` 中 `expiresInDays=0` 表示永久；`visibility=public` 表示匿名公开，`logged-in` 表示需登录，`owner-only` 表示本人及团队。分享范围与站点可见性分别读回，不混为一个开关。
5. 查看已有分享用 `map_web_list_shares`；撤销用 `map_web_revoke_share`。撤销分享不删除站点。

交付时分别说明：原文件是否保留、站点是否更新、返回的分享范围和到期时间、实际打开验证结果。用户要求“公开永久”时，应明确看到 `visibility=public`、无到期时间，并以未登录浏览器打开实际分享链接。检查至少一个子页面跳转、一个图片、一项脚本交互。撤销后再验证旧链接被拒。只有接口返回成功时，写“接口已设置，浏览器访问未验证”，不要写“验收通过”。

若当前工具清单缺少上述工具，停止在该边界，说明具体缺少哪一步；可以引导到 MAP 已有的网页入口。不要以本人及团队可见或 90 天链接替代用户明确要求的公开永久链接。
