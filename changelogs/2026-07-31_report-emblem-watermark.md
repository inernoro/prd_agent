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
