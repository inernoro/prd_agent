| feat | cds | 分支容器覆盖模态新增「保存并立即部署」按钮，一键完成保存→关闭→重部署 |
| fix | cds | `GET /api/branches/:id/profile-overrides` 的 `effective.env` 现在包含 CDS_* 基础设施变量，与运行时实际注入保持一致（新增 `cdsEnvKeys` 字段标识来源） |
| fix | cds | 覆盖模态的公共默认 env 预览从纯文本 `<pre>` 改为可点击列表，CDS_* 变量橙色标注，每行带「→ 编辑」按钮可一键复制到覆盖区 |
| fix | cds | `_collectOverrideFromForm` 正确识别 `KEY=` 空值（保留为空字符串），不再被误判为「继承」 |
| fix | cds | 保存覆盖前检测 CDS_* 变量覆盖，弹出二次确认防止误伤 MongoDB/Redis 等基础服务连接 |
| fix | cds | 保存时跟踪环境变量解析行数，有跳过时 toast 提示「已识别 N 条，跳过 M 条格式错误行」 |
| fix | cds | `PUT /api/branches/:id/profile-overrides/:profileId` 后端拒绝 `containerPort <= 0`，前端 number input 加 `min="1"` |
| fix | cds | 保存/重置请求进行中时禁用所有按钮，防止重复提交 |
| fix | cds | 后端 `env` 字段校验改为排除 null 和数组（`typeof x === 'object'` 陷阱） |
| fix | cds | 后端过滤掉 env 中非字符串值，避免 `undefined`/数字泄漏到 Docker env-file |
