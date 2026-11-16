# 原稿实测规格导出

状态：原稿测量，不是实现验收通过。31 张画板中 25 张功能状态、6 张规范板；使用随用户导出包提供的 9 个原字体文件。

原稿 Main SHA256：`e31a2cc73cfdc27c179f1e4faf37a10c0b348fb8089d0c3b5546de80782d6013`
ZIP SHA256：`7864ff46424616d50d615b3ef7077f8eb01109fa40a99a3a43f630105f3ae548`

## 颜色与尺寸 token 静态映射

只搜索当前产品 status CSS 中的相同字面定义；不等于运行时 computed style 已相等。

| 原稿 token | 原稿值 | 产品 CSS 字面定义 |
|---|---|---|
| --acc | #FF7A1A | 找到 |
| --bg | #0B0C0E | 找到 |
| --gn | #08090B | 找到 |
| --ws | #101215 | 找到 |
| --p1 | #15181C | 找到 |
| --p2 | #1B1F24 | 找到 |
| --p3 | #262B32 | 找到 |
| --t1 | #EEF0F3 | 找到 |
| --t2 | #A3A9B1 | 找到 |
| --t3 | #878D96 | 找到 |
| --ok | #4ADE9A | 找到 |
| --bad | #FF6B63 | 找到 |
| --warn | #F5CF5B | 找到 |
| --none | #6B7280 | 找到 |
| --aw | 320px | 找到 |

## 画板档位

| 原稿画板 | 类型 | 自然视口 | 实测密度 |
|---|---|---|---|
| Main.dc.html | functional-state | 1920 × 1080 | 单行 / 单行 |
| P223-Anno.dc.html | functional-state | 1920 × 1080 | 单行 / 单行 |
| P223-1440.dc.html | functional-state | 1440 × 900 | 单行 / 单行 |
| P223-1280.dc.html | functional-state | 1280 × 800 | 单行 / 单行 / 单行 |
| Density.dc.html | specification | 1920 × 1080 | 规范 / 非全局状态 |
| D17.dc.html | functional-state | 1920 × 1080 | 卡片 / 卡片 / 卡片 / 卡片 / 卡片 |
| D60.dc.html | functional-state | 1920 × 1080 | 两行 / 两行 / 两行 / 两行 / 两行 |
| D200.dc.html | functional-state | 1920 × 1080 | 单行 / 单行 / 单行 |
| NavSpec.dc.html | specification | 1920 × 1080 | 规范 / 非全局状态 |
| TypeSpec.dc.html | specification | 1920 × 1080 | 规范 / 非全局状态 |
| SurfaceSpec.dc.html | specification | 1920 × 1080 | 规范 / 非全局状态 |
| Cat89.dc.html | functional-state | 1920 × 1080 | 单行 / 单行 |
| SvcBad.dc.html | functional-state | 1440 × 900 | 单行 / 单行 |
| SvcNone.dc.html | functional-state | 1920 × 1080 | 单行 / 单行 |
| Return.dc.html | functional-state | 1920 × 1080 | 单行 / 单行 |
| Motion.dc.html | specification | 1440 × 900 | 规范 / 非全局状态 |
| Search.dc.html | functional-state | 1440 × 900 | 单行 / 单行 |
| Filter.dc.html | functional-state | 1920 × 1080 | 单行 / 单行 |
| Notify.dc.html | functional-state | 1440 × 900 | 单行 / 单行 |
| NotifySvc.dc.html | functional-state | 1440 × 900 | 单行 / 单行 |
| Ob1.dc.html | functional-state | 1440 × 900 | 单行 / 单行 |
| Ob2.dc.html | functional-state | 1440 × 900 | 单行 / 单行 |
| Ob3.dc.html | functional-state | 1440 × 900 | 单行 / 单行 |
| ObDone.dc.html | functional-state | 1920 × 1080 | 单行 / 单行 |
| NarrowGlobal.dc.html | functional-state | 390 × 844 | 两行 / 两行 / 两行 / 两行 / 两行 / 两行 / 两行 / 两行 / 两行 / 两行 |
| NarrowMenu.dc.html | functional-state | 390 × 844 | 两行 / 两行 / 两行 / 两行 / 两行 / 两行 / 两行 / 两行 / 两行 / 两行 |
| NarrowSvc.dc.html | functional-state | 390 × 844 | 两行 / 两行 / 两行 / 两行 / 两行 / 两行 / 两行 / 两行 / 两行 / 两行 |
| NotifyLink.dc.html | specification | 1920 × 1080 | 规范 / 非全局状态 |
| LinkBad.dc.html | functional-state | 1920 × 1080 | 单行 / 单行 |
| LinkOk.dc.html | functional-state | 1440 × 900 | 单行 / 单行 |
| LinkBack.dc.html | functional-state | 1920 × 1080 | 单行 / 单行 |

JSON 包含每张原稿的字体/字号/字重/行高/圆角/颜色直方图、五组关键几何测量、原字体元数据、原稿 SHA。隐藏元素会进入直方图，几何记录中的 display/visibility 决定可见性。

Token 静态找到 15 / 15 项；没有宣称缺项为零。

用户要求保留 CDS 原生导航，这是明确例外；不应复刻原型的假全局菜单。