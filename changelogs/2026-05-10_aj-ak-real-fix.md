| fix | cds | EnvSetupDialog 的 SQL 上传卡片现在识别 `CDS_MYSQL_*` `CDS_POSTGRES_*` `DATABASE_URL` 等 cdscli 命名,并叠加 infra services 镜像信号(mysql/postgres/mariadb),mdimp 类项目卡片不再消失 |
| fix | cds | OpsDrawer 改为 non-modal 侧栏:移除全屏 overlay、`aria-modal`、`document.body.overflow=hidden`,打开运维抽屉时 BG 仍可点击与滚动,关闭走 ESC 键或 header 的 X 按钮 |
