| fix | design-runtime | CSS 资源检查仅处理真实样式上下文，避免误拒网页下载使用的本地对象 URL；保留资源完整性与出站安全限制 |
| fix | design-runtime | 保留 SVG 绘图属性的同包资源校验，继续拒绝缺失填充资源与远程滤镜引用 |
| fix | design-runtime | 由现有 HTML tokenizer 区分 HTML 与 SVG style 的有效自闭语义，避免误扫脚本或漏检样式资源 |
