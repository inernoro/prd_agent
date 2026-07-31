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
