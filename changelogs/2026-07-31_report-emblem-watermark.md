| feat | skill | 米多刊系新增刊徽水印：报头右上角一枚天体 SVG（日报月亮 / 周报地球 / 验收北极星 / 巡检彗星，月报太阳预留），衬字板式 opacity 0.13，解决此前四刊只靠身份色区分、缩略图与黑白打印下几乎分不出是哪种报 |
| rule | doc | report-design-system 增 §1.4 刊徽注册表：一刊一徽映射表 + 画法必须走剪影刻线语法（禁线框球）+ 板式参数 + 新增刊物的三步清单 |
| test | ci | 新增 scripts/tests/test_report_emblems.py（CI 自动执行）：钉死每刊有且只有自己那枚徽、SVG 内部 id 可解析、id 带 emb- 前缀防撞车、.emblem 规则确有绝对定位与低透明度 |
| chore | api | 重新生成 official-skills.generated.json（create-visual-test-to-kb 在分发套装内，archive_report.py 改动须同步嵌入资源） |
| fix | skill | 日报模板的刊徽 media 覆盖原本写在基础规则之前，同特异性下被整条盖掉，窄屏拿到的仍是桌面尺寸；移到基础规则之后与周报对齐 |
| test | ci | 刊徽守卫补两条判据：opacity 必须显式声明且落在 (0,0.3]（原先整条删掉时 re.search 返回 None 会静默放行，而 CSS 默认 opacity:1 正是要防的退化）；@media 覆盖必须排在基础规则之后 |
| test | ci | 刊徽守卫补真实渲染验证：实跑 build_interactive_html 两种 flavor，断言各自戴对刊徽——原先只扫源码，_FLAVORS 里两枚对调或都赋同一枚都查不出 |
| fix | ci | 刊徽守卫的 @media 归属判定改按花括号配对，不再看规则所在行有无 @media：验收生成器里 @media 与规则分处两行，按行判会把响应式规则误认成基础规则，层叠顺序检查对它完全失明 |
| rule | doc | 刊徽尺寸改为逐产物登记：模板 92/70 与验收档案 86/60 的差异写明为等比例外（档案报头本就更矮：stamp 44 vs 46、padding-bottom 12 vs 14），不再让规则声称「全刊系一个数」而实现另一套 |
| test | ci | 刊徽守卫新增尺寸契约校验：桌面/窄屏尺寸与偏移逐产物比对规则登记值，改实现不同步改规则即 CI 红 |
| fix | ci | 刊徽守卫改为运行时解析规则 §1.4 尺寸表，不再自存副本：原实现把规则数值硬编码进测试，等于在防漂移的工具里内置一处漂移（只改规则不改守卫仍绿）。解析失败显式判红，拒绝用内置默认值兜底 |
| fix | ci | 尺寸校验补 height：刊徽 viewBox 为正方形，只查 width 时 height 可以悄悄脱钩把水印拉扁 |
| fix | ci | 尺寸校验改取层叠胜者：CSS 同特异性下后写的赢，原实现取第一条匹配——在合法 92px 之后追加一条 .emblem{width:120px}，浏览器渲染 120px 而守卫仍报「符合登记值」；同层出现互相打架的重复声明一律判红 |
| fix | ci | 刊徽守卫接上 CI 触发：release-script-test 的 path filter 原先只含 scripts/tests/test_*.py，被测的三个产物与设计系统规则都没登记——只改模板/规则的 PR 一路全绿而守卫从未跑过，防漂移的工具自己没接上线。顺带补上 test_live_asr_websocket_proxy 的被测文件 cds/src/scheduler/nginx-template.ts（原只在 cds filter 里，那个 job 不跑这批 Python 守卫） |
| test | ci | 刊徽守卫新增 check_ci_wiring：解析 ci.yml 的 release_scripts filter，断言自己的每个输入文件都被某条 glob 覆盖；filter 结构变了解析不出来也判红。日后加第五刊时忘改 ci.yml 会当场红，而不是静默失去覆盖 |
| fix | ci | 定位类判据改取层叠胜者：position/pointer-events 原用「某条规则里出现过」判定，在合法规则后追加一条 .emblem{position:static;pointer-events:auto} 即可让刊徽重回 flex 流并拦鼠标而守卫全绿。取值口径收敛成唯一的 cascade_value，尺寸校验一并复用；顺带把同属衬字契约但一直没查的 z-index 纳入（漂成 1 以上刊徽就从衬底变成盖住刊名） |
| fix | ci | 刊徽守卫补三处判据洞：opacity 改走 cascade_value 并拒收非数值胜者（原正则只认数字，opacity:unset 被跳过而保留前面的 0.13，实际解析为 1 完全不透明）；刊徽全集不再与 ALL_KINDS 求交（未注册的 data-emblem 会被交集滤掉，报告多一枚不受检水印仍判绿）；窄屏 top/right 纳入校验 |
| rule | doc | report-design-system §1.4 尺寸表新增「窄屏偏移」列（模板 top:-8px right:-4px / 档案 top:-8px right:-2px）：原先只登记桌面偏移，窄屏可随意漂——档案窄屏 right 改成 -200px 刊徽整个移出屏幕而守卫判绿 |
| rule | doc | predicate-and-wiring-discipline 补形状 6（判据读的值不是真正生效的那个值：取第一条而非层叠胜者 / 扫源码字面量而非求值结果 / 修完要横扫同类）与形状 7（守卫自己没接上线，形状 2 的递归：CI path filter 不含被守文件），自查清单同步补两条 |
| fix | ci | 刊徽守卫补定位上下文两条判据：刊徽必须长在 masthead 报头内（模板查源码、验收生成器查渲染产物，两条路径合起来必须覆盖全部产物否则判红），且 .masthead 必须是已定位祖先（position:relative 被拿掉时绝对偏移会锚到页面级祖先，水印跑出报头，而只看 .emblem 自身声明的判据全绿） |
| fix | ci | 刊徽守卫补前景层级判据：衬字板式是「刊徽 z-index:0 垫底 + .masthead .t/.r/.stamp position:relative;z-index:1 提到上层」两半合起来才成立，原先只查刊徽那半——三个产物同时删掉前景规则守卫仍判绿，而已定位的 level-0 刊徽会盖过文档流里的报头内容。选择器匹配同时改为按逗号拆开比对（前景是一条三选择器规则，整串 fullmatch 一条都匹配不到） |
| fix | ci | 报头归属判据再收一层：SVG 必须在 `.emblem` 包裹元素内，不只是在 masthead 内——所有样式（定位/尺寸/透明度/层级）都挂在 wrapper 上，把 SVG 挪出 wrapper 当报头兄弟节点时上一版判据仍判绿，而 SVG 会退化成 120x120 文档流 flex 子项撑歪报头 |
| fix | ci | 守卫导入验收生成器时禁用字节码缓存：Python 按 (mtime 秒, 文件大小) 判 .pyc 新旧，改一处等长标记再改回来两项都不变，缓存被判有效、导入到旧字节码——红绿自测会因此得到错误结论 |
| fix | ci | 刊徽发现正则改为捕获整个属性值：原先 `([a-z]+)` 只认纯小写，data-emblem="asteroid-2" 这类值在**发现环节**就进不了集合，后面混装判定与 SVG 完整性检查再宽也看不到它 |
| fix | ci | 守卫改为直接编译执行生成器源码文本，彻底绕开字节码缓存：上一版置 sys.dont_write_bytecode 只挡住写、挡不住读，只要之前留下过合法 .pyc，exec_module 仍会加载旧字节码，守卫验的就不是盘上这份代码 |
| fix | ci | 刊徽守卫改为「凡能命中该元素的规则、每条声明都必须合约定值」，不再按字面选择器匹配 + 算层叠胜者：CSS 胜者由特异性先于源码顺序决定，在 .masthead 前插一条 header.masthead{position:static} 浏览器就用 static，而只认字面 .masthead 的判据完全看不见它。守卫不实现特异性计算（那等于在测试里重写 CSS 引擎），改用更强的契约堵死整类失明 |
| fix | ci | data-emblem 发现与计数改为单双引号都认；顺带修好规则体正则会把 @media 整块吞掉、导致嵌套的窄屏规则整档消失的问题 |
| fix | ci | 契约元素上拒收能绕过长属性判据的简写/逻辑属性（inset* / all / inline-size / block-size）：判据按长属性名精确取值，这些写法根本不进那条正则——`.emblem{inset:0}` 把桌面偏移改成 0、`all:initial` 把整份契约重置，守卫都判绿 |
| fix | ci | data-emblem 属性正则允许等号两侧空白：HTML 允许 `data-emblem = "x"`，此前那枚水印在发现环节就消失 |
| fix | ci | data-emblem 发现正则改为按 HTML 属性语法穷举三种合法写法（双引号/单引号/无引号），不再按「想得到的写法」枚举：该正则已被连续三轮指出收窄，回头对照语法自查又发现第四个维度——无引号值 `data-emblem=asteroid2` 同样合法且仍然漏 |
| fix | ci | 刊徽守卫统一大小写口径：HTML 属性名/标签名、CSS 属性名/at 规则名、关键字值在规范里都是 ASCII 大小写不敏感，判据此前一律按小写字面匹配——DATA-EMBLEM="x"、.emblem{POSITION:static}、<SVG> 三种写法浏览器照用而守卫全绿；同时修好三种合法写法（大写标签、单引号 class 值、@MEDIA）此前会被误判为红的假阳 |
| fix | ci | class 匹配改为按空白分词整词比对，不再用 `\bcls\b`：`\b` 把连字符当词边界，`class="masthead-alt"` / `"emblem-alt"` 会命中判据而浏览器里 `.masthead`/`.emblem` 根本不匹配——重命名 class 导致样式全断，守卫却判绿 |
| fix | ci | 补查行内 style：行内声明优先于任何样式表规则，而判据只扫样式表。给刊徽包裹加 `style="position:static;pointer-events:auto;opacity:1"` 就能让水印回到文档流、变不透明、拦鼠标，守卫全绿。三类契约元素（报头/刊徽包裹/报头前景）的行内 style 一并按同一契约校验并拒收简写 |
| fix | ci | 扫描前先剥 HTML 注释：把 SVG 用 `<!-- -->` 包起来「先留着参考」是常见改法，浏览器不渲染而按原始文本扫描的判据照样数到它，报告上一枚水印都没有却判绿 |
| fix | ci | 可见性纳入刊徽契约：`display:none` / `visibility:hidden` 下前面查的每条属性都仍然正确，但任何视口都不渲染水印——「水印存在」这件事本身此前没进过判据 |
| fix | ci | 报头内禁用不点名类的结构性选择器：`.masthead > div:first-child` 能以更高特异性命中刊徽包裹元素却不提 `.emblem`，靠类名判归属的守卫必然失明；真解需要 CSS 引擎 + DOM，故改为在源头禁掉该写法（现有 CSS 全是点名写法，不受影响） |
| fix | ci | 刊徽/报头/前景的契约收成三份 SSOT（EMBLEM/MASTHEAD/FOREGROUND_CONTRACT），样式表路径与行内 style 路径共用同一份：此前两边各自手列属性，样式表查 6 项、行内只查 3 项，`style="opacity:1"` / `display:none` / `width:120px` 全部判绿——而行内优先级最高，恰恰最不该漏。行内额外禁写分档属性（尺寸/偏移在所有视口一律生效，必然打破其中一档） |
| test | ci | 新增 scripts/tests/test_report_emblems_selftest.py：把此前每轮手工重跑的红绿用例固化成 37 条自动化退化用例，逐条在临时树上施加真实退化并断言守卫判红。守卫判绿只说明「此刻没问题」，不说明「还有能力发现问题」——第 18 轮一次重构删掉三个检查函数的调用点，守卫基线照样全绿，正是靠手工重跑历史用例才发现。用例锚点失效时显式判红，不会静默空跑 |
| fix | ci | 属性名匹配补边界：`data-class="masthead"` 此前会被当成 class 属性命中，浏览器里 `.masthead` 根本不匹配它，刊徽全部样式失配而守卫判绿 |
| fix | ci | 注释剥离补 CSS 注释：只剥 `<!-- -->` 不够，把基础 `.emblem` 规则用 `/* */` 注释掉后浏览器忽略该规则而 rules_targeting 照样收得到，整条契约失效仍判绿 |
| test | scripts | 刊徽守卫补三处判据：主语必须正向点名（:not/:has 里的类不算）、color 纳入可见性契约、守卫脚本自身纳入 CI 接线自查 |
| test | scripts | 刊徽守卫校验窄屏断点与规则表登记一致，颜色 alpha 支持 CSS Color 4 斜杠写法，规则表改按表头名解析 |
| test | scripts | 刊徽守卫区分「默认状态成立」与「有状态」规则：伪类主语不能供给必需声明，但仍须合契约 |
| test | scripts | 刊徽守卫覆盖 .emblem 后代（SVG）的可见性；判据与接线纪律补形状 8（把不成立的证据当成证据） |
| test | scripts | 刊徽守卫覆盖 SVG 自身的行内 style 与表现属性，并解析 color 引用的自定义属性 |
