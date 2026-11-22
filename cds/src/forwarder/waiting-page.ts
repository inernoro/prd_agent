/**
 * 2026-07-09 迁移：页面本体已并入 loading-pages SSOT（https://github.com/inernoro/prd_agent/blob/853023509128fb785541408fd88591db860ce9bf/doc/debt.cds.md「CDS Loading Pages」 D2）。
 * 本模块保留 re-export 以兼容既有 import 路径（forwarder-main.ts / proxy-handler.ts）。
 */
export { buildForwarderWaitingPageHtml } from '../loading-pages/index.js';
