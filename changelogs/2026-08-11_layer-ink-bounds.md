| fix | prd-admin | 包围盒改按「实墨」（alpha ≥ 64）求：几乎看不见的雾不再把部件的框撑到整幅，文字层的框终于贴着字 |
| fix | prd-admin | 整幅淡雾的图层判成空层并默认隐藏：老口径只看 alpha>8，这类层覆盖率不低却一处墨都没有，在画布上变成占满画布的空盒子 |
| fix | prd-admin | 等待动效的流光改用 transform 平移：旧写法动 background-position 百分比，一圈走的距离和平铺周期对不上，每圈结尾都抽搐一下 |
| feat | prd-admin | Frame 头部成为拖拽抓手，拖它整组一起走；并尊重 prefers-reduced-motion |
| test | prd-admin | 补实墨包围盒与淡雾空层的单测（含红绿闭环）、Frame 抓手与动效写法的接线守卫 |
| test | prd-agent | 冒烟扩到 44 条，新增「拖 Frame 头部能带着整组一起走」（动了 4 个，位移完全一致） |
