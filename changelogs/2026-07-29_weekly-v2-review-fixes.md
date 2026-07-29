| fix | prd-admin | 修复知识库 HTML 正文里点击超链接导致整页卡死：父页拦截 iframe 内链接点击改用新标签打开（原先会在自增高 iframe 内导航整个 SPA，100vh 布局与自增高互相喂高触发 ResizeObserver 每帧循环），sandbox 不放宽且对存量旧正文同样生效；另给量高逻辑加失控熔断（1 秒内超 40 次写高即断开观察） |
| fix | skill | 周报采集器改用正式发布台账 /api/releases/runs 统计线上发布，并给出尝试/成功/失败/成功率四个数；分支预览部署版本拆成独立 previewDeploys 段，禁止再充当「线上发布次数」 |
| fix | skill | 周报采集器列日报补 all=true，修复日报被归进文件夹时被静默漏掉并误报「当天无日报」 |
| fix | skill | 周报采集器分享链过滤已过期 token，避免周报给出点开即 404 的日报深链 |
| rule | skill | 周报 html 硬约束新增：所有 a 标签必须带 target=_blank rel=noopener noreferrer；「线上发布」只认正式发布台账口径 |
| docs | doc | 订正 W30 周报的线上发布数据：由错误的「8 个不可变版本」改为正式发布 39 次尝试 / 成功 23 / 失败 16（成功率 59.0%，上周 35.1%） |
| fix | skill | 周报采集器解析项目 slug 为 CDS 规范 projectId（如 mdimp -> defd4695ab5f），避免 slug 与 id 不一致的项目被整体过滤成「0 次发布」的静默错误 |
| fix | skill | 周报采集器按 CDS 终态口径统计发布 run：成功率分母只含终态（success/failed/rollback_*），在途 run 单列 inFlight、回滚单列 rolledBack，消除「1 次尝试 / 0 成功 / 0 失败 / 0%」的自相矛盾 |
| fix | skill | 周报采集器读 CDS 正式发布台账时显式加载项目级 .cds/credentials.json，并把 cdscli die() 抛的 SystemExit 翻成普通异常 + 走 fatal_network_errors=False，避免只有项目级凭据时取不到数、或 CDS 不可达时整个采集器被带走 |
| fix | prd-admin | 知识库正文链接拦截只作用于会真正导航本 frame 的 http(s) 链接，mailto/tel/自定义协议与 download 链接保留原生行为，避免被 preventDefault 变成哑巴链接 |
| fix | skill | publish.py 发布闸新增导航锚点校验：http(s) 链接缺 target=_blank 或 rel=noopener 直接拒发，把原先只写在 SKILL.md 里的约束变成可执行守卫 |
| fix | prd-admin | 链接拦截改读 href 属性 + new URL(raw, baseURI) 解析，覆盖内联 SVG 锚点（SVGAElement 的 .href 是 SVGAnimatedString 非字符串，原实现会漏拦并让 frame 被导航走）|
| fix | skill | 发布闸锚点校验按「会不会导航本 frame」判定：文档相对/上级相对/query-only/根相对/协议相对链接一并纳入校验，仅 mailto/tel/自定义协议与页内锚点、download 放行 |
| fix | prd-admin | 链接拦截覆盖全部可导航锚点形态：a[href]、SVG1.1 的 a[xlink:href]、area[href]（表单提交由 sandbox 无 allow-forms 阻断，base/meta-refresh 由发布闸禁用）|
| fix | skill | 发布闸锚点校验同步覆盖 xlink:href 与 area 标签，19 例形态矩阵双向自测全过 |
| security | prd-admin | 正文链接协议判定改为白名单豁免：只放行 mailto/tel/sms 等外部处理器协议，data:/about:/blob:/javascript:/filesystem: 等会导航当前上下文的协议一律拦截且不开新标签 |
| security | skill | 发布闸同步改白名单豁免，并对 javascript:/data:/blob:/about: 等自导航协议直接拒发 |
| fix | skill | 采集器判定发布台账覆盖完整性：CDS 按每目标 100 条 + 90 天裁剪，补写历史周时给出 coverage 警告，避免把被裁剪后的残缺数据当成完整发布统计 |
| security | skill | 发布闸判协议前按浏览器口径归一化 URL（剔除内部 tab/换行、剥首尾 C0 控制符），堵住 java&#9;script: 这类实体绕过 |
| fix | prd-admin | 量高熔断改为只计真正写高的次数并在熔断前补最后一次写入，避免图多文档 1 秒内几十张图 load 触发误熔断导致内容被永久截断 |
| fix | skill | 发布台账覆盖判定去掉「最早记录晚于周起点」这条会误报的启发式，只从真实保留信号（超 90 天窗口、目标 run 触顶）出发 |
| docs | skill | 周刊模板从订正后的成稿重新派生，清除仍在示范旧「8 次线上发布」口径的样例段落 |
| security | prd-admin | download 链接不再无条件放行：浏览器对跨源 http(s) 会忽略 download 按普通导航处理，现只对同源放行，跨源仍走拦截 |
| security | skill | 发布闸协议豁免收为纯白名单，file:/ftp:/ws: 等可导航标准协议一并要求 target+rel；download 仅对相对 URL（构造上同源）豁免 |
| fix | skill | 覆盖判定改用周起点比对保留边界（修跨 90 天边界周漏判），且 run 触顶需叠加「现存最早记录晚于周起点」才告警，避免把完整数据误标成下限 |
| security | skill | 发布闸按浏览器口径取首个重复属性并直接拒收重复的 href/xlink:href/target/rel，堵住 <a href="javascript:.." href="#safe"> 这类藏在后一个属性里的绕过 |
| security | skill | 发布闸要求 rel 同时含 noopener 与 noreferrer，与技能/模板声明的契约对齐 |
| docs | skill | 清除周刊模板与成稿里最后一处旧口径「本周已有 8 次真实发布」，三份产物发布数字口径统一 |
| fix | skill | 覆盖判定的保留边界改用 >=：CDS 淘汰线是滚动 90*24h 而此处只有日期粒度，起点正好第 90 天时当天清晨的 run 已可被删，用 > 会漏判成完整 |
| fix | skill | 条数触顶从「丢数警告」降级为提示（advisories）：n==上限只说明恰好装满，新目标攒满 100 条时第 101 条从未存在，原判据会把准确数据误标成下限 |
| fix | skill | 采集器项目标识改按 id/slug/name 集合匹配：/api/releases/runs 存的是 slug 而 cdscli 返回 hex id，先前归一成单一 id 会把本项目全部 run 静默滤成「0 次发布」 |
| fix | skill | 台账非空却被项目过滤器全部滤空时改报 available=false + 实际写法示例，拒绝以「本周未发布」的姿态输出静默错误 |
| fix | skill | 采集器把 cdscli 在本进程内的打印改道 stderr：die() 会往 stdout 打一行 JSON，导致 CDS 不可达时 stdout 变成两段 JSON 拼接、下游解析直接炸 |
| rule | skill | 周报纪律 12 补「不可用 ≠ 0」：available=false 只能写数据不可用，只有 available=true 且 attempts=0 才写本周未发布 |
| test | skill | 新增周报采集器判据回归（8 例，含保留边界/条数闸/标识集合/滤空守卫），逐条验证删掉对应修复即变红 |
| security | prd-admin | 链接拦截区分「无 href 属性」与「href 空串」：srcdoc 的 base URL 继承父页，href="" 会解析成宿主 SPA 地址并导航本 frame，原先当 no-op 放行等于给卡死路径留了后门 |
| security | skill | 发布闸同步拒收空 href（含纯空白），并按浏览器口径在 href 与 xlink:href 都存在时取 href（不能用 or 串联，空串是 falsy 会串到后者） |
| docs | skill | 周刊 baseline 行/页脚/术语表的第四源署名由「部署版本」改为「正式发布台账 /api/releases/runs」，并在术语表拆开两个词条——此前只改了数字没改来源署名，等于把正确数字挂在被判作废的来源名下 |
| rule | skill | 纪律 12 写明第四源必须署名「正式发布台账」，且 baseline/页脚/术语表/附录四处署名要一致 |
