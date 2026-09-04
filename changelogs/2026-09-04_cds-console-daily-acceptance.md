| feat | cds | 新增 scripts/smoke/cds-console-acceptance.mjs：每日视觉验收扩到 CDS 控制台，且首次引入窄屏档（390x844）——原例程只跑 1600x1000 一个桌面视口，整条 loop 从来没有任何一个窄屏判据 |
| test | cds | 判据三条并列：路由独有锚点命中 + 全局错误边界「页面渲染异常」缺席 + 无 4xx/5xx 与 pageerror；窄屏另加横向溢出与上手向导每步出口可达 |
| test | cds | 新增 scripts/tests/cds-console-acceptance-anchors.test.mjs：锚点不许与外壳导航重名、必须真的出现在它声称的页面组件里、向导不许推进到会往生产写的那一步 |
| ci | cds | ci.yml 的 release_script 过滤器登记被守的四个页面组件与 AppShell——只改页面文案的 PR 才是真正会引入锚点漂移的那种 |
| docs | cds | 台账记下「每日验收从来没有窄屏档」：MAP 那条仍只有 1600x1000 一档，等 CDS 这条稳定跑一周再补，并把「稳定」写成三条可机械核对的判据 |
