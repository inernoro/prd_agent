| refactor | prd-api | 网关宽接口改为继承 Core 窄接口，删掉装配时的运行时强制类型转换：两处独立声明合成一处，签名漂移由编译期拦截 |
| refactor | prd-api | 网关契约命名空间由 Infrastructure 改为 Core，与所在项目对齐；136 个引用文件按编译器报错精确补 using，并清掉脚本多加的 33 条 |
