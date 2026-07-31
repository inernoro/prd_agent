| feat | skill | 米多刊系新增刊徽水印：报头右上角一枚天体 SVG（日报月亮 / 周报地球 / 验收北极星 / 巡检彗星，月报太阳预留），衬字板式 opacity 0.13，解决此前四刊只靠身份色区分、缩略图与黑白打印下几乎分不出是哪种报 |
| rule | doc | report-design-system 增 §1.4 刊徽注册表：一刊一徽映射表 + 画法必须走剪影刻线语法（禁线框球）+ 板式参数 + 新增刊物的三步清单 |
| test | ci | 新增 scripts/tests/test_report_emblems.py（CI 自动执行）：钉死每刊有且只有自己那枚徽、SVG 内部 id 可解析、id 带 emb- 前缀防撞车、.emblem 规则确有绝对定位与低透明度 |
| chore | api | 重新生成 official-skills.generated.json（create-visual-test-to-kb 在分发套装内，archive_report.py 改动须同步嵌入资源） |
| fix | skill | 日报模板的刊徽 media 覆盖原本写在基础规则之前，同特异性下被整条盖掉，窄屏拿到的仍是桌面尺寸；移到基础规则之后与周报对齐 |
| test | ci | 刊徽守卫补两条判据：opacity 必须显式声明且落在 (0,0.3]（原先整条删掉时 re.search 返回 None 会静默放行，而 CSS 默认 opacity:1 正是要防的退化）；@media 覆盖必须排在基础规则之后 |
