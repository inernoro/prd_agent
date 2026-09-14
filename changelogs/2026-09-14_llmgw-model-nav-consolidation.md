| refactor | llmgw | 上游页展开即见名下模型与登记状态，没登记的排前面并直说「调用方找不到它」 |
| refactor | llmgw | Provider 与 Exchange 合成「上游」一个入口两段，/exchanges 落到转接上游段、锚点保留 |
| refactor | llmgw | 模型池停止新建（冻结横幅指向模型页），保留摘成员/恢复/停用等修复动作 |
| refactor | llmgw | 路由导航五条收成两条（模型 / 上游），三条旧地址保留路由与页内入口 |
| refactor | llmgw | 「模型白名单」页标题改为「模型」，与导航同名 |
| test | prd-api | 新增两条跨模块守卫：上游名下模型接线、导航两条且旧地址不留死链；均做过红绿闭环 |
| chore | prd-api | 测试项目删掉两个已由 ProjectReference 提供的 Compile Link，消除 CS0436 |
| fix | llmgw | /v1/models 的 DataContext 参数补 [FromServices]，不注册它的宿主不再整张端点表构建失败 |
| test | prd-api | 新增 serving 端点绑定守卫：最小宿主上枚举 EndpointDataSource 必须建得起来 |
