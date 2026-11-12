# CDS 验收报告传输与取证适配（按需加载）

**一句话**：正式验收由标准技能执行，CDS 负责保存报告、证据资产与项目归属。
**谁该读**：从 CDS 部署、页面验收或交付收尾进入报告流程的 Agent。
**读完能做什么**：调用正确的验收入口，使用 CDS 适配器取证和查询归档结果。

## 正式验收唯一入口

开发交付需要验收报告，或用户提出页面、功能、回归验收时，先读取 [create-visual-test-to-kb](../../create-visual-test-to-kb/SKILL.md)，不等显式 `/验收` 命令。复杂场景按它的前置要求执行 [acceptance-test-design](../../acceptance-test-design/SKILL.md) → [acceptance-scenario-orchestrator](../../acceptance-scenario-orchestrator/SKILL.md) → 取证归档。

模板、档位、截图标注、独立触控移动端、manifest、结论与准入规则，以该技能引用的仓库规范为唯一主源；本参考不维护另一套报告流程。

正式链路必须保留：

1. 需求或提交范围、测试设计和必要的场景编排。
2. 标准 harness 的取证与 manifest，逐图回读；历史图片只能保留原始来源，不补写未执行的标注或移动端事实。
3. Markdown 写作源交给标准 `archive_report.py`，通过准入后生成模板 HTML 并归档 CDS。
4. 运行标准 `verify-open.mjs`，验证线上正文、图片、全部内部链接与跳转结果；采用受保护会话时沿标准脚本支持的认证适配执行。

`human-verify`、`/uat` 和交接报告只提供上游输入，不能替代这条链。`cdscli report create` 是通用存储命令，上传成功不代表验收合格。禁止自行拼 HTML、补模板标记、自定义档位或用抽查图片替代标准准入与打开校验。

## CDS 浏览器取证适配

标准取证工具位于 `create-visual-test-to-kb/scripts/`。CDS 自身的登录与网络适配位于 `../cli/acceptance/`：

- `cds-harness.mjs`：复用标准 harness 的表单登录、点击导航、标注、截图、主题与 manifest 能力。
- `driver.template.mjs`：CDS 剧本骨架，不另行定义验收报告结构。
- `proxyroute.mjs`：仅在浏览器网络确需出口代理适配时使用；不能注入合成业务结果或伪造登录来声明真实流程通过。
- `cds.config.example.json`：按被测应用指定安全凭据来源。CDS、预览专用凭据与 MAP 凭据分别绑定其真实登录域，不能互用。

`build_report_html.py` 仅保留历史资料兼容或诊断用途，不能用于新的执行类验收报告。旧版“内联图片、自行组装 HTML、直接 report create”流程不再作为验收入口。

被测应用、项目、登录、预览地址和归档文件夹在本次临时配置中确定；不要直接把 MAP 默认配置用于 CDS。凭据只引用安全环境变量，不写入配置、报告或仓库。预览地址从 `cdscli preview-url` 或实际 CDS API 读取。

## 归档结果查询

标准归档脚本负责生成和写入报告；CDS CLI 用于查询归属和真实链接：

```bash
python3 .claude/skills/cds/cli/cdscli.py report list --project <projectId>
python3 .claude/skills/cds/cli/cdscli.py report-folder list --project <projectId>
python3 .claude/skills/cds/cli/cdscli.py report deeplink <reportId>
```

归档前从标准技能读取当前命令与必填参数，不复制维护另一条上传示例。报告按项目和文件夹归类；标题、Verdict、L0/L1/L2、分支与完整提交号采用标准技能要求。

CDS 直达深链默认为登录态门控。只有用户需要对外分享时才创建匿名分享，不为验证方便擅自改变可见性。正文或证据未就绪、标准校验未过时，保持验收未完成；重测生成新报告，不覆写历史证据。

## 存储与接口（排障用）

- 报告元数据与正文分开保存；正文的 `storage`、`objectKey` 才是实际存储事实，本地文件只作缓存或明确诊断用途。
- 截图先进入内容寻址资产库，正文引用不可变 HTTPS URL；10MB 是正文上限，不能靠删减必要证据迁就它。
- 报告接口为 `/api/reports`，证据资产接口为 `/api/reports/assets`，文件夹接口为 `/api/report-folders`。
- 实际直达深链由 CLI 返回，前端按 `project`、`folder`、`report` 参数定位。
- Verdict 和部署上下文供验收看板使用；未经用户授权不回写 PR、不发送通知、不创建公开分享。

## 跨系统展示

报告归 CDS；MAP 等系统可通过知识库开放协议从 CDS 拉取。跨系统展示不改变验收主源、模板或归档完成条件。

配对与同步操作见核心 CDS 技能，只有用户要求建立该连接时才执行。归档本身不需要新建 MAP 验收知识库。
