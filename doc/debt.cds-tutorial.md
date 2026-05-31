# CDS 教程 · 债务台账

> **版本**：v1.0 | **日期**：2026-05-30 | **状态**：维护中

记录「从零开始的 CDS 教程」(示例工程 + 隔离知识库 + compose 评分/自愈)的已知边界与后续可补项。

## 已知边界

| ID | 严重度 | 创建日期 | 描述 | 触发条件 | 状态 | 备注 |
|---|---|---|---|---|---|---|
| T1 | 低 | 2026-05-30 | `verify --fix --write` 用 PyYAML 重序列化整文件,注释丢失、缩进风格变化 | 对带注释的 compose 跑 `--write` | open | 默认只打印 diff;文档已提示先看 diff 再 write。后续可换保留注释的 ruamel.yaml |
| T2 | 低 | 2026-05-30 | 自愈覆盖面有限:目前只自动修 `env-var-unresolved` / `depends-on-hint`,其余只给建议 | 遇到 app-ports-missing / infra-image-missing 等需人决策的 ERROR | open | 这是有意为之(机器不能瞎猜端口/镜像);扩面时按 §4.5 加 fixer |
| T3 | 低 | 2026-05-30 | `env-var-unresolved` 自动修补的是占位值 `CHANGE_ME`,verify 会过但值是假的 | 用自愈后直接部署没改占位 | open | 输出已标 needsReview;部署前必须人工改真值 |
| T4 | 低 | 2026-05-30 | 4 个示例工程的可部署性仅本地 verify(评分 A)确认,完整 deploy+冒烟依赖 CDS 环境 | 无 CDS 凭据的环境 | open | 评分门禁已挡静态问题;真机冒烟需 `cdscli deploy` 在有 CDS 的环境跑 |
| T5 | 低 | 2026-05-30 | 知识库发布脚本需要 `CDS_TUTORIAL_IMPERSONATE`(真实用户名),不提供则退出 | 跑 publish 脚本 | open | 有意要求:store 必须归属真实 owner,不允许匿名建库 |

## 后续可补

- 把 `cds/examples/tutorial-04-fullstack-infra` 与 `cds/examples/fullstack-infra-smoke` 的 compose 收敛为单一来源,避免双份维护漂移。
- `verify --fix` 支持保留注释(ruamel.yaml),消除 T1。
- 评分 rubric 增加「最佳实践」维度(如 `:latest` tag 扣分),目前只看部署正确性。
