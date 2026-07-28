| feat | cds | 新增全局快捷提 bug（Ctrl+B / Command+B + 右下角常驻入口），自动带入页面地址/路由/主题/视口/浏览器信息，支持粘贴与拖拽截图 |
| feat | cds | 新增 POST/GET /api/bug-reports：配置 MAP 缺陷系统凭据时由服务端带凭据转发（create + submit），未配置或转发失败则本地留存并如实告知未同步 |
| feat | llmgw | 网关控制台新增同款全局快捷提 bug 面板，走 theme.css token 双主题适配 |
| feat | llmgw | console-api 新增 POST/GET /gw/bug-reports：支持转发到 MAP 缺陷系统，未配置时落 llmgw_bug_reports 集合并回报降级原因 |
| test | cds | 新增快捷键判定/环境采集/payload 组装（cds 与 llmgw 两份实现同组断言）与 /api/bug-reports 路由契约测试 |
| fix | cds | 修复截图附件在生产必然 413：全局 100kb JSON 解析器新增 /api/bug-reports 跳过，路由自挂 24mb 解析器（覆盖 12MB 附件经 base64 膨胀后的体积），超限回中文 JSON 而不是 HTML |
| fix | cds | 修复复制集压测四个端点缺 Activity Monitor 中文 label（发起压测/列出压测记录/取消压测/查看压测报告），cancel 排在单段 runId 之前不被吞 |
| fix | cds | 修复右下角提交缺陷 pill 压住页面操作反馈 toast：新增共享安全偏移 lib/overlayOffsets，pill 与六个页面的 toast 共用同一份几何常量 |
| fix | cds | 修复提 bug 转发超时预算：create 与 submit 由各 10s 改为共用 10s 总预算，兑现前端「超过 10 秒转本地留存」文案 |
| fix | llmgw | 修复 POST /gw/bug-reports 违反 server-authority：转发与落库改用与请求生命周期解耦的独立超时/CancellationToken.None，用户切页不再导致 MAP 已建缺陷而网关无记录 |
| fix | llmgw | 修复附件可能顶穿 MongoDB 16MB 单文档上限：总量闸改按 base64 字符长度计，并给 InsertOneAsync 套 try/catch，失败返回中文原因而不是裸 500 |
| test | cds | 新增生产同款 body 解析装配的 413/大附件用例、压测端点 label 守卫、右下角浮层不重叠守卫、llmgw 提 bug 端点源码守卫 |
| security | cds | 修复项目级 Key 可读取全部项目缺陷台账（正文含页面地址与 query、提交人、环境信息）：缺陷是 CDS 系统级数据且无项目维度可过滤，按既有约定拒绝项目级凭据 |
| fix | cds | 修复转发到缺陷系统时截图从未上传：此前只 create+submit，正文里仅有文件名，UI 却报「已提交」；改为 submit 前逐个上传附件，部分失败如实回传而非谎报成功 |
