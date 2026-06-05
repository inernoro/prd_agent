| fix | prd-api | 真因修复：DeleteEntry 之前无条件级联删 Document（共享 SHA-256 内容寻址），把别人引用的 Document 一起删了 → 受害者预览空白 |
| fix | prd-api | DocumentSyncWorker hash 短路 + 304 短路加 self-heal：若 Document 已丢失则强制重拉，让历史污染条目自动恢复 |

