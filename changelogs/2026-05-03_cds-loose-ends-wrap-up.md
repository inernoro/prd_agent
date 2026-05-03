| fix | cds | F18: dropdown「从 GitHub 选仓库」改为直接弹 GithubRepoPickerDialog（之前要先开新建表单再点一次），少一次手动操作；CreateProjectDialog 加 autoOpenPicker prop 在挂载后自动 setRepoPickerOpen(true) |
| feat | cds-skill | F13: cdscli verify 新增 INFO 规则 `infra-init-script-detected` — 扫到 `./*.sql:/docker-entrypoint-initdb.d/*` 类挂载时给出确认提示（同 service 多脚本聚合一行），让用户可见 cdscli 已识别到 init.sql |
| fix | cds-skill | F14: `schemaful-db-no-migration` WARNING 收敛 — 任意 infra 已挂 init script 到 /docker-entrypoint-initdb.d/ 时不再误报，fix 文案同时给 ORM migration 与 init.sql 两条路径；mysql/postgres demo 走 init.sql 不再被当成漏配 ORM |
