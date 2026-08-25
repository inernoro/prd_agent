| feat | platform | 12 块设计画板全部量出档位表并固化进仓库（带画布 sha256），token 闸门跑通，缺项收敛到 8 个真值 |
| fix | platform | 取证按画板选择器切，不再按 y 区间：并排摆放的三个上传态原先取出的文案是三屏并集（12 屏里 5 屏的文案证据是错的） |
| fix | platform | tokens-map 按维度限定候选 token（字号不再匹配到圆角 token），项目未用 token 管的维度如实报「不这么管」而不是每档算缺 |
| fix | platform | 取证脚本改用 playwright-core + 容器预装浏览器，setup 不再卡在下载浏览器上 |
