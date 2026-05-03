| fix | cds | F18: dropdown「从 GitHub 选仓库」改为直接弹 GithubRepoPickerDialog（之前要先开新建表单再点一次），少一次手动操作；CreateProjectDialog 加 autoOpenPicker prop 在挂载后自动 setRepoPickerOpen(true) |
| feat | cds-skill | F13: cdscli verify 新增 INFO 规则 `infra-init-script-detected` — 扫到 `./*.sql:/docker-entrypoint-initdb.d/*` 类挂载时给出确认提示（同 service 多脚本聚合一行），让用户可见 cdscli 已识别到 init.sql |
| fix | cds-skill | F14: `schemaful-db-no-migration` WARNING 收敛 — 任意 infra 已挂 init script 到 /docker-entrypoint-initdb.d/ 时不再误报，fix 文案同时给 ORM migration 与 init.sql 两条路径；mysql/postgres demo 走 init.sql 不再被当成漏配 ORM |
| feat | cds | F12: 新增 `POST /api/projects/:id/files` 端点 + ProjectFilesService — 接受 `{branch, files:[{relativePath, content}]}` 写入 worktree（路径白名单 / 单文件 ≤256KB / 单次 ≤1MB / ≤50 个文件）；EnvSetupDialog 检测 mysql/postgres infra 时新增「上传 init.sql」卡片，省掉「git push 才能跑 demo」的步骤 |
| feat | cds | F11: `POST /api/projects` 新增沙盒模式 — 接受 `{composeYaml, projectFiles[]}` 不需 gitRepoUrl，后端在 reposBase 本地 `git init -b main` + 写文件 + commit + 自指 origin（让后续 worktree 走 `origin/main` 路径不需特判）；ProjectListPage dropdown 新增「从 YAML 沙盒新建」入口 + SandboxProjectDialog（粘贴 yaml + 加额外文件） |
| fix | cds-web | Bug A: BranchListPage 加载体验 — 取消远程分支冷启动 force-fetch 兜底（之前每次都跑 30s git fetch 阻塞首屏），改成手动「拉取远程」按钮；loading 文案从「加载分支与远程引用」改为「加载项目与本地分支列表」消歧 |
| fix | cds-web | Bug B: 状态 chip「运行中 vs 未运行」视觉差强化 — 运行中 font-semibold + 实心绿点 + 微光环；未运行/已停止 opacity-60 + 空心灰圈，扫一眼可区分；同步改 BranchListPage 与 BranchDetailDrawer 两套 statusClass |
| fix | cds-web | Bug C: 服务详情面板「左 220px 列表 + 右日志」改为「顶部 tab 横排 + 下方日志全宽」，腾出横向空间显示完整 docker logs，不用拖横向滚动条 |
