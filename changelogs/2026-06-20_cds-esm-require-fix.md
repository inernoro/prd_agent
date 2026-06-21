| fix | cds | 修复 ESM 模块内 require('node:*') 运行时报错（memory 后端鉴权全 500、stack 检测、TCP 探测三处） |
| test | cds | 新增 ESM 卫士测试，禁止源码出现 CommonJS require() 调用（单测因 CJS interop 掩盖此类 bug） |
