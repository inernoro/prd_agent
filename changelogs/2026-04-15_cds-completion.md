| fix | cds | UF-02 回归:`bootstrapMeLabel()` 改为幂等可重入,Device Flow ready 后主动刷新左下角徽章;未解析状态 tooltip 带诊断字符串指向哪个 probe 失败;HTML placeholder 从"未登录"改"加载中…"避免 initial flash 误导 |
| feat | cds | UF-09:Topology Variables tab 支持继承+覆盖 —— 按 branchId 拉 `/profile-overrides`,每行左侧眼睛 toggle(闭眼=继承,开眼=覆盖,橙色=CDS 基础设施锁定),右侧 value input 400ms debounce PUT 写回 branch override;共享视图回退只读 + 提示"选分支切可覆盖模式" |
| fix | cds | UF-10:拓扑视图点"编辑"不再跳回列表 —— `_topologyPanelOpenEditor`/`_topologyPanelOpenLogs`/`_topologyChooseAddItem` 三处删除 `setViewMode('list')`,全部 in-place 调用 `openProfileModal`/`openRoutingModal`/`openInfraModal`/`openLogModal`;同时替换不存在的 `renderBuildProfiles`/`renderRoutingRules` 遗留符号 |
| feat | cds | GAP-04:Topology Details 面板新增"路由"tab,按 profileId 过滤 `routingRules` 展示所有命中规则,编辑按钮 in-place 调 `openRoutingModal` |
| feat | cds | GAP-05:Topology Details 面板 Settings tab 新增"部署模式"区块,遍历 `entity.deployModes` 展示每条策略 |
| feat | cds | GAP-06:Topology Details 面板 Settings tab 新增"集群派发"区块,遍历 `executors` 展示主/远端节点 |
| feat | cds | GAP-07:Topology Details 面板新增"备注"tab,渲染 `entity.notes` + `entity.tags` 自由文本,编辑按钮 in-place 打开 profile 编辑器 |
| feat | cds | GAP-08:Topology 节点卡片右下新增可交互端口 pill,单击复制 `host:port` + toast,双击已选分支时走 `previewBranch`,否则开新标签访问 raw `host:port` |
| feat | cds | GAP-09:拓扑视图预览入口风格与列表对齐 —— 端口 pill 承担 Quick Action 角色,hover 切 accent 色 + 图标反馈 |
| feat | cds | L10N-02:`app.js` 中 Railway 术语汉化 —— "Service is online"→"服务运行中","PUBLIC URL"→"公开地址","CONNECTION STRINGS"→"连接串","SERVICE INFO"→"服务信息","Service Variables"→"环境变量","Host view/Container view"→"宿主机视角/容器视角","GitHub Repository/Database/Docker Image/Routing Rule/Empty Service"→"GitHub 仓库/数据库/Docker 镜像/路由规则/空服务";Details 面板 7 个 tab 全部改中文标签 |
| feat | cds | L10N-03:`projects.html` 汉化 —— 页面 title、"Projects/New/Dashboard/System/Personal"→"项目列表/新建项目/控制台/系统/个人工作区","Sort by: Recent Activity"→"按最近活跃排序" |
| feat | cds | FU-01:Repo Picker 分页 —— `fetchUserReposPage(token, page)` 新增,解析 GitHub `Link` header 的 `rel="next"`;`/api/github/repos?page=N` 路由返回 `{repos, hasNext, page}`;前端 Repo Picker 末尾渲染"加载更多(第 N 页)"按钮,点击追加下一页 |
| feat | cds | FU-05:Device Flow token AES-256-GCM 加密 —— 新增 `cds/src/infra/secret-seal.ts` 提供 `sealToken`/`unsealToken`,从 `CDS_SECRET_KEY` 环境变量派生密钥(支持 64-hex / base64 / SHA-256 passphrase 三种格式);`state.ts setGithubDeviceAuth` 写入前密封,`getGithubDeviceAuth` 读取时透明解密;未设置密钥时回退明文(向后兼容旧 state.json) |
| test | cds | 新增 `tests/infra/secret-seal.test.ts` 16 条单元测试,覆盖密封/解封/round-trip/tamper-detect/key-rotation/passphrase 派生/向后兼容路径;测试总数 543 → 560 |
