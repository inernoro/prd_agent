# 范围、截图与自动化接入

## 一、冻结范围

从仓库根目录运行。日期模式取目标分支第一父提交历史上业务日开始和结束前的快照，避免把次日提交纳入日检。若要检查未合并分支，直接提供分支或具体 SHA。

```bash
python3 .claude/skills/cds-skeleton-review/scripts/plan.py
python3 .claude/skills/cds-skeleton-review/scripts/plan.py --date 2026-11-20 --ref origin/main
python3 .claude/skills/cds-skeleton-review/scripts/plan.py --base HEAD~1 --head HEAD
python3 .claude/skills/cds-skeleton-review/scripts/plan.py --base HEAD --head HEAD --include-worktree
```

`routes` 按优先级排列，依次为左侧菜单、其他控制台入口和已登记独立页。专用页面文件只映射到登记中共享该文件的路由，包括别名。共享组件、样式、路由壳和 API 路由改动保守纳入全部已登记入口。`sharedOrUnmappedFiles` 要逐项核对，新增、重命名或删除路由时对照两个版本的 `App.tsx` 与 `loading-scenes.json`，补记未登记入口与旧入口行为。动态路由参数、查询、锚点优先从实际页面、测试夹具或权威预览获取。旧路由及新入口没有可用的样本时写明阻塞。

后端服务或生成数据使页面变化时，同样纳入受影响路由。范围脚本对这类间接改动保留文件路径，执行人据差异和页面请求补齐映射。

指定路由时使用当前目标构建，直接核对路由登记和场景。全量检查按登记顺序覆盖当前入口，另核对已删除路由的兼容行为。共享导航或布局修改时，根据影响范围扩展到其下游路由。确认没有页面受影响后，记录范围和原因即可结束，避免安装浏览器或构建。

## 二、取证和修复

- 使用已安装的浏览器工具或仓库 Playwright 驱动。先从项目列表点入菜单页，验证菜单动作与正确高亮。另从查询路由访问二级页，复验分享深链、别名或落地页。
- 本地浏览器用独立 context。分别把目标页面 chunk 或必要 GET 响应挂起，确认已命中等待路径后截图，再放行并等待目标组件和字体就绪。可参照 `cds/scripts/loading-continuity-smoke.mjs`、`cds/scripts/list-loading-smoke.mjs`、`cds/scripts/mobile-layout-smoke.mjs` 和 `cds/scripts/fixtures/mobile-layout-fixtures.mjs`。夹具仅拦截本机目标，带有效的空态或非空样本，浏览器异常、权限页和错误页要记入结果。
- 先用定位元素的可见性、位置、尺寸和溢出断言定位布局差异，再回看图片。结果受内容长度、字体、抗锯齿或动效影响时，用相同条件重测对应元素。骨架色块和真实文字天然有像素差异，逐像素对比可用于发现异常，布局结论以关键区域的测量和回读为准。
- 用目标 SHA 构建最初样本，用候选构建取最终证据。触发真实业务写入、发布、删除和回滚需已有相应授权。缺少同版本预览时记录环境边界。脱敏、证据存放和报告归档沿用仓库验收流程。
- 拼图工具依赖 Python 3 与 Pillow 10.1 或更新版本。在已有受管环境中安装或使用现有图像工具生成同尺寸拼图。每个设备使用同一对源视口，桌面原图等比缩小，手机原图保留完整像素。输出写入仓库外的运行目录。

```bash
python3 .claude/skills/cds-skeleton-review/scripts/compare.py \
  --device desktop --route /project-list \
  --skeleton "$CDS_REVIEW_OUT/projects-desktop-skeleton.png" \
  --loaded "$CDS_REVIEW_OUT/projects-desktop-loaded.png" \
  --out "$CDS_REVIEW_OUT/projects-desktop-pair.png"
```

将两张手机原图传给同一命令并使用 `--device mobile`。手机 manifest 记录触控原图的 390×844 视口、`isMobile` 和 `touchPoints`。两侧图的包装尺寸可以为 804×916。留存原图供回读。只有实际测量支持的区域可以写成几何一致。

## 三、校验与交付

从仓库根目录运行。预览运行在本机，使用生产模式构建。按变更运行对应模块测试、主题、手机菜单及加载失败后重试用例。

```bash
pnpm --dir cds/web typecheck
pnpm --dir cds/web build
pnpm --dir cds audit:loading
pnpm --dir cds exec vitest run tests/web/single-skeleton-contract.test.ts tests/web/loading-scene-registry.test.ts
pnpm --dir cds exec node scripts/loading-continuity-smoke.mjs "$CDS_REVIEW_LOCAL_URL" --out "$CDS_REVIEW_OUT/continuity"
```

只检查一组已登记路由时，可向连续性命令传入 `--only` 与逗号分隔的登记路径。连续性脚本验证两段等待的结构与几何，再由截图核对实际内容。最终检查每条计划路由都有有效双端证据或具体阻塞。按 `create-visual-test-to-kb` 指引使用标准脚本生成报告，验证线上深链。归档或打开校验失败时，报告状态保持未完成。

修复分支或补丁应能在后续运行中找到。调度环境会销毁工作区时，把补丁作为受支持的运行产物保留，明确目标 SHA。生成补丁前在隔离工作区将本轮新增文件登记为 intent-to-add，再用 `git diff --binary HEAD`，使补丁包含新增骨架。报告附交付位置和已验证范围。

## 四、自动化调用提示

扫描取证可由标准 GitHub 托管 Ubuntu runner 运行项目现有的 Playwright 和 Chromium 脚本。先计算范围，确认有受影响路由再安装依赖、构建和启动浏览器。优先复用现有 [CDS CI](../../../../.github/workflows/cds.yml) 的浏览器缓存与合成数据，日常任务按路由取证，PR 沿用完整回归。公开 Actions 产物只收录合成数据的报告、布局测量和截图，建议短期保留。需要真实账号或项目数据的预览验收和 CDS 报告归档使用已有授权的项目环境。

扫描交接记录基础和目标 SHA、路由与场景、角色和主题、等待阶段、夹具和视口、偏移实测、截图路径与阻塞。只有稳定重现的布局失败触发「骨架更新」。成功、无影响以及基础设施阻塞均直接汇报。更新任务接收失败记录和授权交付位置，复现后在同样条件下复拍。同版本报告归档后仍需执行打开校验。

```text
骨架扫描
按 Asia/Shanghai 上一完整自然日的 origin/main 净改动检查受影响页面。
逐页报告桌面与手机对比、测量结果和阻塞。
```

```text
骨架更新 /project-list
复现扫描报告中的失败场景，在授权的修复工作区保留改动。
用同条件复拍，汇报修复、回归结果、证据与阻塞。
```

## 五、故障判定

| 观察 | 处置 |
|---|---|
| 手机加载时没有菜单入口，真实页面有入口 | 独立触控上下文验证两段等待和加载完成态，打开抽屉检查高亮、横向溢出和页面跳转。复用公共导航壳后复拍。 |
| 返回、别名或旧链接落地异常 | 从真实菜单走一遍，再访问具体深链。页面下线时校验旧入口的预期重定向，并检查菜单是否仍有入口。 |
| 登录、夹具、预览或容器启动阻塞 | 记录目标 SHA、失败阶段和缺失前置。分别标明本地合成数据和线上预览覆盖。页面布局状态标为未验证。 |
| Actions 里 Chromium 在首屏前报 `browserType.launch` 超时 | 对照失败步骤、当前 SHA 和主分支近期记录，只重跑失败任务一次。必要时用同一脚本对照基线和候选，分别保留结果。持续失败时汇报步骤、超时和影响范围。只有页面进入并命中布局断言后，才根据差异修骨架。 |
