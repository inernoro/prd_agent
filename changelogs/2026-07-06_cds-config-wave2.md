| feat | cds | 新增分支「生效配置检查器」:GET /branches/:id/effective-config 端点输出逐 key env 溯源(12 种来源:全局/项目/分支/服务底座/分支覆盖/部署模式/临时服务/平台注入/分支库改写等)+ 覆盖链(shadowed)+ 部署计划预览(起哪些容器/连哪些网/拉起哪些共享 infra) |
| feat | cds | 分支抽屉新增「配置」tab + 分支详情页新增「生效配置」区,继承链树视图 + 来源徽标 + 密钥脱敏 |
| refactor | cds | 容器运行时 env 解析抽为纯函数 env-provenance.ts(带溯源分层),部署路径退化为单层包装,行为逐字节等价(container.test.ts 43 例护栏 + 等价断言) |
