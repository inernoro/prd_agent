| feat | cds | push 按仓库分发到该仓库下的**全部**项目，不再只认第一个；主结果之外的项目挂在 fanout 上，路由对它们的部署一视同仁派发 |
| feat | cds | 新增项目级作用域判据：作用域取该项目名下全部服务 buildScope 的并集，未声明即全通配（零回归），拿不到改动清单时 fail-open |
| feat | cds | compose 支持服务级 `cds.build-scope` 标签，让没有部署模式的服务也能声明构建输入范围 |
| feat | cds | 自托管项目 compose 声明作用域 `cds/**`，link 之后只有改到 CDS 自身代码的 push 才会重编它 |
| refactor | cds | `findProjectByRepoFullName` 改为委托给新的复数版，两者匹配口径收敛成一份 |
| test | cds | 补作用域判据 17 例、多项目分发 9 例、路由分发 2 例，含「删掉 fanout 循环即变红」的红绿闭环 |
