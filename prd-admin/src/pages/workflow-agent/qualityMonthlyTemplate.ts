import type { WorkflowNode, WorkflowEdge, WorkflowVariable } from '@/services/contracts/workflowAgent';

// ═══════════════════════════════════════════════════════════════
// 模板: 米多技术质量月报看板（多月切换 + ECharts 图表）
// ═══════════════════════════════════════════════════════════════
//
// 拓扑图：
//   👆 手动触发
//     ↓
//   🌐 HTML 网页渲染（JS 确定性生成，所有数据内嵌）
//     ↓
//   💾 导出 HTML
//

let _eid = 0;
function e(src: string, ss: string, tgt: string, ts: string): WorkflowEdge {
  return { edgeId: `e-qm-${_eid++}`, sourceNodeId: src, sourceSlotId: ss, targetNodeId: tgt, targetSlotId: ts };
}

// ── 生成完整 HTML 的 JS 代码 ──────────────────────────────────
// 所有数据 hardcoded 在脚本中，ECharts 渲染图表，纯前端月份切换
const htmlGenCode = `
// ═══ 米多技术质量月报看板 ═══
var H = [];
var S = '<' + 'script>';
var SE = '<' + '/' + 'script>';

// ── 数据定义 ──
var months = ["10月","11月","12月"];
var heroData = {
  "10月": {techBugs:29,critical:0,timelyRate:93.1,fixRate:86.2,validFB:43},
  "11月": {techBugs:23,critical:2,timelyRate:95.24,fixRate:85.7,validFB:43},
  "12月": {techBugs:39,critical:1,timelyRate:89.19,fixRate:71.05,validFB:54}
};
var sevData = {
  "10月": {P0:0,P1:0,P2:5,P3:23,P4:1},
  "11月": {P0:1,P1:1,P2:2,P3:19,P4:0},
  "12月": {P0:1,P1:0,P2:7,P3:29,P4:2}
};
var statusData = {
  "10月": {"已修复":25,"临时解决":3,"处理中":1,"挂起":0,"逾期":0},
  "11月": {"已修复":18,"临时解决":3,"处理中":1,"挂起":1,"逾期":0},
  "12月": {"已修复":27,"临时解决":6,"处理中":3,"挂起":2,"逾期":4}
};
var rcData = {
  "10月": [["技术分析不足",16],["测试体系不完善",14],["性能设计不足",5],["产品设计不完善",3],["发布不规范",2],["监控建设不完善",2]],
  "11月": [["技术分析不足",12],["测试体系不完善",6],["应用架构/监控不完善",3],["暂未归母",3],["重复问题",2],["性能设计不足",1]],
  "12月": [["测试体系不完善",12],["技术分析不足",10],["性能设计不足",3],["资源管理不规范",3],["发布不规范",2],["产品设计不完善",2],["监控体系不完善",1],["暂未归母",2]]
};
// 趋势数据
var trendLabels = ["5月","6月","7月","8月","9月","10月","11月","12月"];
var trendValid  = [47,41,52,58,70,43,43,54];
var trendInvalid= [12,10,8,7,17,13,12,17];
var trendTotal  = [59,51,60,65,87,56,55,71];
var timelyTrend = {labels:["6月","7月","8月","9月","10月","11月","12月"],values:[57.1,76.7,72.5,81.4,93.1,95.24,89.19]};
var fixTrend = {labels:["7月","8月","9月","10月","11月","12月"],values:[76.7,57.5,72.1,86.2,85.7,71.05]};
var p0p1Trend = {labels:["3月","4月","5月","6月","7月","8月","9月","10月","11月","12月"],p0:[0,1,0,2,0,0,0,0,1,1],p1:[3,0,0,1,2,3,2,0,1,0]};

// 重大缺陷
var critAlerts = {
  "10月": [],
  "11月": [
    {level:"P0",title:"按箱指定发奖超发一等奖（再来一瓶提领券大量超发）",desc:"溯源报告已出"},
    {level:"P1",title:"全平台瘫痪——米多大数据引擎无法登陆，消费者扫码获取商家信息失败",desc:"全平台回溯报告已出"}
  ],
  "12月": [
    {level:"P0",title:"扫码跳转不良网址",desc:"WiFi链路劫持，非米多服务器问题，联合腾讯云/网警排查"}
  ]
};

// 缺陷详情
var defectDetails = {
  "10月": [
    {cat:"测试体系不完善",color:"#E84040",items:[
      {d:"终端动销领奖导出\\"奖品发放\\"栏信息显示错误",c:"逻辑错误·状态处理问题（数组索引依赖约定被打破）",h:""},
      {d:"经销商列表无法加载、重复出现",c:"API调用参数错误·重构测试覆盖不足",h:""},
      {d:"礼品兑换加载失败",c:"条件判断错误（未查询到分类时错误返回）",h:""},
      {d:"批量导入发货600条长时卡死",c:"业务规则实现不完整（未处理不存在订单场景）",h:""},
      {d:"生码小标数量缺失",c:"数据格式错误（起始流水号未清空导致范围重叠）",h:""}
    ]},
    {cat:"技术分析不足",color:"#F5A623",items:[
      {d:"渠道返利数据导出生成失败",c:"",h:""},
      {d:"导购积分商城订单导出门店编号/名称缺失",c:"接口未返回 AttachData 字段",h:""},
      {d:"出货数据未自动同步",c:"开放平台接口缺少动销码字段，旧数据未赋值",h:""},
      {d:"会员小程序我的奖品加载超时",c:"查询范围近2年大数据接口超时",h:""},
      {d:"托盘出货报\\"未将对象引用设置到对象的实例\\"",c:"托盘传值未做防空判断",h:""},
      {d:"自有礼品下架后仍提示需要下架",c:"旧版积分商城缺少导购积分商城数据过滤",h:""}
    ]},
    {cat:"发布不规范",color:"#FF6B35",items:[
      {d:"核销提领券显示\\"系统繁忙\\"",c:"发布前未同步关联同事/SVN分支未规范",h:""},
      {d:"扫码提示\\"系统维护中\\"",c:"代码逻辑未逐行复查",h:""}
    ]},
    {cat:"监控建设不完善",color:"#1E6FD9",items:[
      {d:"消费者扫码未触发渠道返利",c:"",h:""},
      {d:"店铺开箱数据显示暂无",c:"服务器重启导致存储过程中断，重复数据异常",h:""}
    ]}
  ],
  "11月": [
    {cat:"测试体系不完善",color:"#E84040",items:[
      {d:"扫码领奖扫码地址超出数据库字段长度导致报错",c:"",h:""},
      {d:"防伪码流水号查找失败返回错误数据",c:"",h:""},
      {d:"万能溯源码扫码报 System.Exception",c:"接口新增入参未设默认值",h:""},
      {d:"按箱发奖超发（同P0）",c:"",h:""},
      {d:"门店扫码领奖显示\\"总部未出货\\"但实际已出货",c:"",h:""},
      {d:"微信红包发放明细导出数据与查询不一致",c:"",h:""}
    ]},
    {cat:"技术分析不足",color:"#F5A623",items:[
      {d:"宴席订单导出重复记录",c:"Goose组件分页未指定排序规则",h:""},
      {d:"BDE后台生成订单报服务器错误",c:"对象非空判断缺失",h:""},
      {d:"云店分销二维码扫码只进入总店",c:"接口返回37008时未加地理位置逻辑",h:""},
      {d:"红包发放明细导出失败",c:"ES查询字段 d_id 不存在",h:""},
      {d:"订单付款后状态不刷新",c:"支付回调慢时状态非7（待处理）不触发轮询",h:""},
      {d:"中山市门店注册定位失败",c:"腾讯地图更新与本地地址库不匹配",h:""}
    ]},
    {cat:"应用架构/监控不完善",color:"#FF6B35",items:[
      {d:"出货600件只同步160件",c:"死锁（顺德酒厂码关系表）",h:""},
      {d:"奖品订单\\"该地区不支持配送\\"+500报错",c:"日志增长过快磁盘爆满，告警阈值设置不当",h:""},
      {d:"全平台瘫痪（同P1）",c:"",h:""},
      {d:"微信绑定收不到验证码",c:"环境配置错误",h:""}
    ]}
  ],
  "12月": [
    {cat:"测试体系不完善",color:"#E84040",items:[
      {d:"天津市（直辖市）扫码地区统计无法显示下级市区",c:"地址默认三级，直辖市二级未做兼容",h:""},
      {d:"客户列表导入手机号提示\\"尚未拥有用户标签\\"",c:"提前判断标签存在，非必填项不应阻断",h:""},
      {d:"订单10个月/14个月未自动签收",c:"自动签收逻辑仅覆盖会员小程序，未兼容导购小程序",h:""},
      {d:"品牌红包开票申请提交失败",c:"多条订单ID拼接超数据库字段长度",h:""},
      {d:"发奖策略按行政区域+GPS双重条件未用\\"或\\"逻辑判断",c:"导致大范围区域无人领奖",h:""},
      {d:"同一二维码可重复关联",c:"数据关联未做去重检查",h:""}
    ]},
    {cat:"技术分析不足",color:"#F5A623",items:[
      {d:"微信授权验证失败",c:"历史登录信息只判断第一条",h:""},
      {d:"二返积分补发失败",c:"资产接口超时但实际发放成功，业务数据未同步更新",h:""},
      {d:"经销商报销生成二维码失败",c:"Linux环境.NET6不支持Common库",h:""},
      {d:"大标签收未完成导致出货失败",c:"签收时码关系更新接口未排除经销商ID/门店ID",h:""},
      {d:"批量导入发货失败",c:"Nginx跨域配置遗漏域名",h:""},
      {d:"新客开通套餐报错",c:"外勤管理模块错误关联到付费套餐",h:""}
    ]},
    {cat:"性能设计不足",color:"#FF6B35",items:[
      {d:"发放明细查不到发放失败记录",c:"接口响应超时，无自动补发机制",h:""},
      {d:"导入22万溯源码超时（1小时未完成）",c:"",h:""},
      {d:"红包发放失败提示系统繁忙",c:"",h:""}
    ]},
    {cat:"资源管理不规范",color:"#1E6FD9",items:[
      {d:"导购中心显示乱码",c:"某台服务器缺少依赖文件",h:""},
      {d:"箱码扫描显示接口通讯异常",c:"灰度测试误操作更新错误站点配置",h:""},
      {d:"智能营销首页昨日扫码量为0",c:"新购服务器磁盘未挂载，无监控",h:""}
    ]}
  ]
};

// 总结
var summaryData = {
  "10月": [
    {icon:"warn",color:"#F5A623",text:"复合根因占比高：技术分析不足与测试覆盖不足超 30% 缺陷由多环节共同导致"},
    {icon:"doc",color:"#E84040",text:"发布规范问题突出：项目杂乱，发布前未同步关联同事"},
    {icon:"ok",color:"#27C97F",text:"系统稳定性问题较上月减少：与重启服务器内存有效释放有关"}
  ],
  "11月": [
    {icon:"bell",color:"#F5A623",text:"无效反馈仍较多，占用研发团队大量时间"},
    {icon:"sync",color:"#E84040",text:"方案改动未及时同步导致问题发生，项目部分流程缺失"},
    {icon:"lock",color:"#E84040",text:"主库权限开放过高，操作风险极大"},
    {icon:"loop",color:"#FF6B35",text:"分页问题重复出现"}
  ],
  "12月": [
    {icon:"up",color:"#F5A623",text:"反馈问题数量较11月增加，有效反馈维持较高水平（约76%）"},
    {icon:"chart",color:"#FF6B35",text:"及时处理率89.19%较高，但修复率仅71.05%，临时解决占比偏高需重点跟进"},
    {icon:"alert",color:"#E84040",text:"P0重大缺陷1个（WiFi链路劫持，非米多服务器问题）"}
  ]
};

// 改进计划
var improvePlans = {
  "10月": [
    ["流程","每天在一杆枪群同步问题进度；未解决问题重新评估预计时间"],
    ["测试","建立公共测试用例库，供所有项目复用"],
    ["运维","思进指定运维重启服务器注意事项；监测好资源利用率"],
    ["规范","云峰制定项目发布规范（SVN/GIT拉分支规范参考语雀链接）"],
    ["性能","月度分析报告：数据库索引碎片、SQL慢查询、Nginx访问响应慢监控"]
  ],
  "11月": [
    ["监控","线上所有 ERROR 都应告警；统计各 appname ERROR 情况，清理无效日志后按项目负责人推送"],
    ["工单","接入工单系统，告警形成工单推送至负责人微信，记录查看时间与完结时间，处理时效纳入考核"],
    ["流程","方案改动须及时同步项目团队；测试用例不论项目大小均需评审；改动后全盘复测"],
    ["文档","测试报告按模板填写，放在技术分析文档子文档下"],
    ["安全","非必要不在堡垒机操作，操作需向上反馈"],
    ["代码","Java 项目避免再出现分页问题"]
  ],
  "12月": [
    ["安全","客户敏感信息不截图，保护账户密码"],
    ["监控","品牌红包发放加监控，先加重试次数观察"],
    ["规范","建立：用例评审清单 / 技术分析清单 / 运维操作注意清单"],
    ["测试","空白数据需用新品牌商测试"],
    ["质量","排查问题举一反三，类似问题一并修复"],
    ["兼容","组件升级向下兼容，升级覆盖测试，发版前发公告"],
    ["监控","生码过程加入监控"]
  ]
};

// 运维/专项
var specialContent = {
  "10月": [],
  "11月": [
    {type:"doc",title:"11月 SQL慢查询分析报告"},
    {type:"doc",title:"11月 慢查询分析报告"},
    {type:"doc",title:"11月 数据索引分析报告"},
    {type:"doc",title:"运维SLA月度统计报告"},
    {type:"ai",title:"Cursor Plan 模式培训 ——《让 AI 从\\"盲从\\"进化到\\"思考\\"》"}
  ],
  "12月": [
    {type:"doc",title:"12月 数据库索引分析报告"},
    {type:"doc",title:"12月 SQL慢查询分析报告"},
    {type:"doc",title:"2026-01-05 日志统计"},
    {type:"ai",title:"AI 培训专题，调整至 2026年1月13日下午5点至7点进行"}
  ]
};

// ── HTML 输出 ──
H.push('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">');
H.push('<meta name="viewport" content="width=device-width,initial-scale=1.0">');
H.push('<title>米多技术专业委员会 · 线上质量月报看板</title>');
H.push('<link rel="preconnect" href="https://fonts.googleapis.com">');
H.push('<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Noto+Sans+SC:wght@400;600;700&display=swap" rel="stylesheet">');
H.push(S.replace('>',  ' src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js">') + SE);

// ── CSS ──
H.push('<style>');
H.push(':root{--bg:#0D1117;--card:#161B22;--elev:#1C2128;--bdr:#30363D;--t1:#E6EDF3;--t2:#7D8590;--blue:#1E6FD9;--orange:#F5A623;--green:#27C97F;--red:#E84040;--cyan:#4ECDC4}');
H.push('*{box-sizing:border-box;margin:0;padding:0}body{font-family:"Noto Sans SC",sans-serif;background:var(--bg);color:var(--t1);line-height:1.6;min-height:100vh}');
H.push('.ctn{max-width:1400px;margin:0 auto;padding:0 24px}');
H.push('.nav{position:sticky;top:0;z-index:100;background:rgba(13,17,23,0.92);-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);border-bottom:1px solid var(--bdr);padding:0 24px}');
H.push('.nav-in{max-width:1400px;margin:0 auto;display:flex;align-items:center;height:56px;gap:16px}');
H.push('.logo{width:32px;height:32px;background:linear-gradient(135deg,var(--blue),var(--cyan));border-radius:8px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:14px}');
H.push('.nav-t{font-weight:700;font-size:1rem;white-space:nowrap}');
H.push('.tabs{display:flex;gap:4px;margin-left:auto}');
H.push('.tab{padding:6px 20px;border-radius:6px;cursor:pointer;font-size:0.85rem;font-weight:600;color:var(--t2);transition:0.2s;border:1px solid transparent}');
H.push('.tab:hover{color:var(--t1);background:rgba(30,111,217,0.08)}.tab.active{color:var(--blue);background:rgba(30,111,217,0.12);border-color:rgba(30,111,217,0.3)}');
// Sections
H.push('.sec{padding:40px 0}.sec-t{font-size:1.3rem;font-weight:700;margin-bottom:20px;background:linear-gradient(135deg,var(--t1),var(--blue));-webkit-background-clip:text;-webkit-text-fill-color:transparent}');
H.push('.kg{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:40px}');
H.push('.kpi{background:var(--card);border:1px solid var(--bdr);border-radius:12px;padding:20px;transition:0.3s;position:relative;overflow:hidden}');
H.push('.kpi:hover{transform:translateY(-4px);box-shadow:0 8px 24px rgba(0,0,0,0.3)}.kpi:before{content:"";position:absolute;top:0;left:0;right:0;height:3px;background:var(--kpi-color,var(--blue));opacity:0;transition:0.3s}.kpi:hover:before{opacity:1}');
H.push('.kpi-l{font-size:0.78rem;color:var(--t2);margin-bottom:6px;font-weight:600}');
H.push('.kpi-v{font-family:"Bebas Neue",monospace;font-size:2.8rem;line-height:1}.kpi-d{font-size:0.7rem;margin-top:6px}');
// Charts
H.push('.cg{display:grid;grid-template-columns:repeat(2,1fr);gap:20px;margin-bottom:32px}');
H.push('.cc{background:var(--card);border:1px solid var(--bdr);border-radius:12px;padding:24px}.cc h3{font-size:0.95rem;margin-bottom:16px;font-weight:600}');
H.push('.chart-box{width:100%;height:300px}');
// Status
H.push('.sg{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:24px}');
H.push('.sc{background:var(--card);border:1px solid var(--bdr);border-radius:8px;padding:14px;text-align:center}');
H.push('.sc-n{font-family:"Bebas Neue",monospace;font-size:1.8rem}.sc-l{font-size:0.75rem;color:var(--t2)}');
// Root cause bars
H.push('.bl{display:flex;flex-direction:column;gap:8px}');
H.push('.bi{display:flex;align-items:center;gap:10px}.bi-l{flex:0 0 180px;font-size:0.82rem;text-align:right;color:var(--t2)}');
H.push('.bi-t{flex:1;height:26px;background:var(--elev);border-radius:4px;overflow:hidden}');
H.push('.bi-f{height:100%;border-radius:4px;display:flex;align-items:center;justify-content:flex-end;padding-right:8px;font-size:0.72rem;font-weight:700;color:rgba(255,255,255,0.9);transition:width 0.6s ease}');
// Alerts
H.push('.alert{background:rgba(232,64,64,0.08);border:1px solid rgba(232,64,64,0.3);border-radius:12px;padding:16px 20px;margin-bottom:12px;display:flex;align-items:flex-start;gap:12px}');
H.push('.alert-b{background:var(--red);color:#fff;padding:2px 8px;border-radius:4px;font-size:0.75rem;font-weight:700;flex-shrink:0}');
H.push('.alert-t{font-weight:600;color:var(--red)}.alert-d{font-size:0.82rem;color:var(--t2);margin-top:4px}');
// Accordion
H.push('.acc{display:flex;flex-direction:column;gap:8px}');
H.push('.ag{background:var(--card);border:1px solid var(--bdr);border-radius:8px;overflow:hidden}');
H.push('.ah{display:flex;align-items:center;gap:10px;padding:12px 16px;cursor:pointer;transition:0.2s}.ah:hover{background:rgba(255,255,255,0.03)}');
H.push('.ad{width:8px;height:8px;border-radius:50%;flex-shrink:0}.ac-name{font-weight:600;flex:1}');
H.push('.ab{background:rgba(30,111,217,0.15);color:var(--blue);padding:2px 10px;border-radius:12px;font-size:0.7rem;font-weight:700}');
H.push('.abdy{max-height:0;overflow:hidden;transition:max-height 0.4s ease}.ag.open .abdy{max-height:5000px}');
H.push('.dl{padding:4px 16px 16px;display:flex;flex-direction:column;gap:6px}');
H.push('.df{display:flex;gap:10px;padding:10px 12px;background:var(--elev);border-radius:6px;border-left:3px solid var(--blue);font-size:0.85rem}');
H.push('.di{flex-shrink:0;width:20px;height:20px;background:rgba(30,111,217,0.15);color:var(--blue);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:0.65rem;font-weight:700}');
H.push('.dc{margin-top:3px;font-size:0.8rem;color:var(--orange)}');
// Summary & Improve
H.push('.smg{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px}');
H.push('.smc{background:var(--card);border:1px solid var(--bdr);border-radius:12px;padding:18px 20px;display:flex;align-items:flex-start;gap:14px}');
H.push('.smi{flex-shrink:0;width:36px;height:36px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px}');
H.push('.imp-list{display:flex;flex-direction:column;gap:6px}');
H.push('.imp-item{display:flex;align-items:flex-start;gap:10px;padding:10px 14px;background:var(--card);border:1px solid var(--bdr);border-radius:8px;font-size:0.85rem}');
H.push('.imp-num{flex-shrink:0;width:22px;height:22px;background:rgba(30,111,217,0.15);color:var(--blue);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:0.65rem;font-weight:700}');
H.push('.imp-tag{flex-shrink:0;padding:1px 6px;border-radius:3px;font-size:0.65rem;font-weight:600;background:rgba(30,111,217,0.15);color:var(--blue)}');
// Special
H.push('.spec-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}');
H.push('.spec-card{background:var(--card);border:1px solid var(--bdr);border-radius:8px;padding:16px 20px;transition:0.2s}');
H.push('.spec-card:hover{border-color:var(--blue);transform:translateY(-2px)}');
H.push('.spec-type{font-size:0.7rem;color:var(--cyan);font-weight:600;margin-bottom:4px}.spec-title{font-size:0.9rem;font-weight:600}');
// Footer
H.push('.ft{text-align:center;padding:32px 0;border-top:1px solid var(--bdr);color:var(--t2);font-size:0.8rem}');
// Responsive
H.push('@media(max-width:900px){.cg{grid-template-columns:1fr}.sg{grid-template-columns:repeat(3,1fr)}.kg{grid-template-columns:repeat(2,1fr)}.bi-l{flex:0 0 100px;font-size:0.72rem}}');
// Month panel
H.push('.month-panel{display:none}.month-panel.active{display:block}');
H.push('</style></head><body>');

// ── Navbar ──
H.push('<nav class="nav"><div class="nav-in"><div class="logo">M</div>');
H.push('<span class="nav-t">米多技术专业委员会 · 线上质量月报</span>');
H.push('<div class="tabs" id="monthTabs">');
months.forEach(function(m,i){
  H.push('<div class="tab'+(i===2?' active':'')+'" data-month="'+m+'" onclick="switchMonth(this)">'+m+'</div>');
});
H.push('</div></div></nav>');

// ── 每月面板 ──
months.forEach(function(m, mi) {
  var hero = heroData[m];
  var sv = sevData[m];
  var st = statusData[m];
  var rc = rcData[m];
  var active = mi === 2;
  H.push('<div class="month-panel'+(active?' active':'')+'" id="panel-'+m+'">');
  H.push('<div class="sec"><div class="ctn">');

  // Hero KPIs
  H.push('<div class="kg">');
  var kpis = [
    {l:"技术缺陷总数",v:hero.techBugs,c:"#1E6FD9"},
    {l:"P0/P1 重大缺陷",v:hero.critical,c:hero.critical===0?"#27C97F":"#E84040"},
    {l:"及时处理率",v:hero.timelyRate+"%",c:hero.timelyRate>=90?"#27C97F":hero.timelyRate>=80?"#F5A623":"#E84040"},
    {l:"修复率(P2及以下)",v:hero.fixRate+"%",c:hero.fixRate>=90?"#27C97F":hero.fixRate>=80?"#F5A623":"#E84040"},
    {l:"有效反馈数",v:hero.validFB,c:"#4ECDC4"}
  ];
  kpis.forEach(function(k){
    var zeroStyle = (k.l==="P0/P1 重大缺陷" && k.v===0) ? '<span style="font-size:0.7rem;color:var(--green);margin-left:8px">&#10003; 本月清零</span>' : '';
    H.push('<div class="kpi" style="--kpi-color:'+k.c+'"><div class="kpi-l">'+k.l+'</div>');
    H.push('<div class="kpi-v" style="color:'+k.c+'">'+k.v+zeroStyle+'</div></div>');
  });
  H.push('</div>');

  // Critical Alerts
  var alerts = critAlerts[m] || [];
  if (alerts.length > 0) {
    H.push('<h3 class="sec-t">重大缺陷警报</h3>');
    alerts.forEach(function(a){
      H.push('<div class="alert"><span class="alert-b">'+a.level+'</span><div>');
      H.push('<div class="alert-t">'+a.title+'</div>');
      if(a.desc) H.push('<div class="alert-d">'+a.desc+'</div>');
      H.push('</div></div>');
    });
  }

  // Section 1: Charts
  H.push('<h3 class="sec-t" style="margin-top:24px">数据概况</h3>');
  H.push('<div class="cg">');
  H.push('<div class="cc"><h3>TAPD 线上问题概况</h3><div class="chart-box" id="trendChart-'+m+'"></div></div>');
  H.push('<div class="cc"><h3>缺陷级别分布</h3><div class="chart-box" id="sevChart-'+m+'"></div></div>');
  H.push('<div class="cc"><h3>P2及以下缺陷及时处理率</h3><div class="chart-box" id="timelyChart-'+m+'"></div></div>');
  H.push('<div class="cc"><h3>P2及以下缺陷修复率</h3><div class="chart-box" id="fixChart-'+m+'"></div></div>');
  H.push('<div class="cc"><h3>P0/P1 重大缺陷趋势</h3><div class="chart-box" id="p0p1Chart-'+m+'"></div></div>');
  H.push('<div class="cc"><h3>处理状态总览</h3><div class="chart-box" id="statusChart-'+m+'"></div></div>');
  H.push('</div>');

  // Section 2: Defect Analysis - Root cause bars
  H.push('<h3 class="sec-t">缺陷母体分布</h3>');
  var rcMax = rc.length > 0 ? rc[0][1] : 1;
  var rcColors = ["#E84040","#F5A623","#FF6B35","#1E6FD9","#4ECDC4","#27C97F","#7D8590","#9CA3AF"];
  H.push('<div style="background:var(--card);border:1px solid var(--bdr);border-radius:12px;padding:24px;margin-bottom:32px"><div class="bl">');
  rc.forEach(function(r,ri){
    var pW = Math.max(r[1]/rcMax*100,8);
    H.push('<div class="bi"><div class="bi-l">'+r[0]+'</div>');
    H.push('<div class="bi-t"><div class="bi-f" style="width:'+pW+'%;background:'+rcColors[ri%rcColors.length]+'">'+r[1]+'</div></div></div>');
  });
  H.push('</div></div>');

  // Defect Accordion
  var dets = defectDetails[m] || [];
  if (dets.length > 0) {
    H.push('<h3 class="sec-t">典型缺陷详情</h3><div class="acc">');
    dets.forEach(function(grp,gi){
      var q = String.fromCharCode(39);
      H.push('<div class="ag'+(gi===0?' open':'')+'">');
      H.push('<div class="ah" onclick="this.parentElement.classList.toggle('+q+'open'+q+')">');
      H.push('<div class="ad" style="background:'+grp.color+'"></div>');
      H.push('<div class="ac-name">'+grp.cat+'</div>');
      H.push('<div class="ab">'+grp.items.length+'</div>');
      H.push('<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--t2)"><path d="M6 9l6 6 6-6"/></svg>');
      H.push('</div><div class="abdy"><div class="dl">');
      grp.items.forEach(function(item,ii){
        H.push('<div class="df" style="border-left-color:'+grp.color+'">');
        H.push('<div class="di">'+(ii+1)+'</div><div style="flex:1">');
        H.push('<div>'+item.d+'</div>');
        if(item.c) H.push('<div class="dc">'+item.c+'</div>');
        if(item.h) H.push('<span style="display:inline-block;margin-top:3px;background:rgba(125,133,144,0.15);color:var(--t2);padding:1px 6px;border-radius:8px;font-size:0.65rem">'+item.h+'</span>');
        H.push('</div></div>');
      });
      H.push('</div></div></div>');
    });
    H.push('</div>');
  }

  // Section 3: Summary
  var sums = summaryData[m] || [];
  if (sums.length > 0) {
    H.push('<h3 class="sec-t" style="margin-top:32px">缺陷总结</h3><div class="smg">');
    sums.forEach(function(s){
      var bg = (s.color||"#1E6FD9")+"22";
      H.push('<div class="smc"><div class="smi" style="background:'+bg+';color:'+s.color+'">&#9679;</div>');
      H.push('<div style="font-size:0.88rem">'+s.text+'</div></div>');
    });
    H.push('</div>');
  }

  // Section 4: Improvement Plan
  var imps = improvePlans[m] || [];
  if (imps.length > 0) {
    H.push('<h3 class="sec-t" style="margin-top:32px">改进计划</h3><div class="imp-list">');
    imps.forEach(function(imp,ii){
      H.push('<div class="imp-item"><div class="imp-num">'+(ii+1)+'</div>');
      H.push('<div class="imp-tag">['+imp[0]+']</div>');
      H.push('<div style="flex:1">'+imp[1]+'</div></div>');
    });
    H.push('</div>');
  }

  // Section 5: Special Content
  var specs = specialContent[m] || [];
  if (specs.length > 0) {
    H.push('<h3 class="sec-t" style="margin-top:32px">专项内容</h3><div class="spec-grid">');
    specs.forEach(function(sp){
      var typeLabel = sp.type==="doc" ? "运维报告" : "AI 提效";
      H.push('<div class="spec-card"><div class="spec-type">'+typeLabel+'</div><div class="spec-title">'+sp.title+'</div></div>');
    });
    H.push('</div>');
  }

  H.push('</div></div></div>'); // close sec, ctn, panel
});

H.push('<footer class="ft"><div class="ctn">米多技术专业委员会 · 质量月报看板 | 由工作流自动生成</div></footer>');

// ── JavaScript ──
H.push(S);
H.push('function switchMonth(el){');
H.push('  document.querySelectorAll(".tab").forEach(function(t){t.classList.remove("active")});');
H.push('  el.classList.add("active");');
H.push('  var m=el.getAttribute("data-month");');
H.push('  document.querySelectorAll(".month-panel").forEach(function(p){p.classList.remove("active")});');
H.push('  var p=document.getElementById("panel-"+m);if(p)p.classList.add("active");');
H.push('}');
H.push(SE);

// ── ECharts 初始化 ──
H.push(S);
H.push('document.addEventListener("DOMContentLoaded",function(){');
H.push('if(typeof echarts==="undefined")return;');

// 通用暗色 tooltip
H.push('var tt={backgroundColor:"rgba(22,27,34,0.95)",borderColor:"#30363D",textStyle:{color:"#E6EDF3"}};');
H.push('var axC={axisLine:{lineStyle:{color:"#30363D"}},splitLine:{lineStyle:{color:"rgba(48,54,61,0.5)"}},axisLabel:{color:"#7D8590"}};');

// Trend chart
H.push('var tL='+JSON.stringify(trendLabels)+',tV='+JSON.stringify(trendValid)+',tI='+JSON.stringify(trendInvalid)+',tT='+JSON.stringify(trendTotal)+';');
H.push('["10月","11月","12月"].forEach(function(m){');
H.push('var dom=document.getElementById("trendChart-"+m);if(!dom)return;');
H.push('var ch=echarts.init(dom);ch.setOption({tooltip:Object.assign({trigger:"axis"},tt),legend:{textStyle:{color:"#7D8590"},top:0},grid:{top:40,bottom:30,left:40,right:20},');
H.push('xAxis:{type:"category",data:tL,axisLabel:{color:"#7D8590"},axisLine:{lineStyle:{color:"#30363D"}}},');
H.push('yAxis:{type:"value",axisLabel:{color:"#7D8590"},splitLine:{lineStyle:{color:"rgba(48,54,61,0.5)"}}},');
H.push('series:[{name:"有效反馈",type:"line",data:tV,smooth:true,itemStyle:{color:"#1E6FD9"},lineStyle:{width:2}},');
H.push('{name:"无效反馈",type:"line",data:tI,smooth:true,lineStyle:{type:"dashed",color:"#7D8590"},itemStyle:{color:"#7D8590"}},');
H.push('{name:"总数",type:"line",data:tT,smooth:true,itemStyle:{color:"#F5A623"},lineStyle:{width:2}}]});');
H.push('window.addEventListener("resize",function(){ch.resize()});});');

// Severity donut per month
H.push('var sevAll='+JSON.stringify(sevData)+';');
H.push('["10月","11月","12月"].forEach(function(m){');
H.push('var dom=document.getElementById("sevChart-"+m);if(!dom)return;var sv=sevAll[m];');
H.push('var total=sv.P0+sv.P1+sv.P2+sv.P3+sv.P4;');
H.push('var ch=echarts.init(dom);ch.setOption({tooltip:Object.assign({trigger:"item"},tt),');
H.push('legend:{orient:"vertical",right:10,top:"center",textStyle:{color:"#7D8590"},itemGap:14},');
H.push('graphic:{elements:[{type:"text",left:"center",top:"42%",style:{text:total,fill:"#E6EDF3",font:"bold 36px Bebas Neue",textAlign:"center"}},{type:"text",left:"center",top:"55%",style:{text:"本月缺陷",fill:"#7D8590",font:"12px Noto Sans SC",textAlign:"center"}}]},');
H.push('series:[{type:"pie",radius:["50%","75%"],center:["40%","50%"],avoidLabelOverlap:false,');
H.push('itemStyle:{borderRadius:6,borderColor:"#161B22",borderWidth:3},label:{show:false},');
H.push('emphasis:{label:{show:true,fontSize:14,fontWeight:"bold",color:"#E6EDF3"}},');
H.push('data:[{value:sv.P0,name:"P0 致命",itemStyle:{color:"#E84040"}},{value:sv.P1,name:"P1 重大",itemStyle:{color:"#F5A623"}},{value:sv.P2,name:"P2 严重",itemStyle:{color:"#FF6B35"}},{value:sv.P3,name:"P3 一般",itemStyle:{color:"#1E6FD9"}},{value:sv.P4,name:"P4 轻微",itemStyle:{color:"#4ECDC4"}}]}]});');
H.push('window.addEventListener("resize",function(){ch.resize()});});');

// Timely rate chart
H.push('var tlD='+JSON.stringify(timelyTrend)+';');
H.push('["10月","11月","12月"].forEach(function(m){');
H.push('var dom=document.getElementById("timelyChart-"+m);if(!dom)return;');
H.push('var ch=echarts.init(dom);ch.setOption({tooltip:Object.assign({trigger:"axis"},tt),grid:{top:20,bottom:30,left:50,right:20},');
H.push('xAxis:{type:"category",data:tlD.labels,axisLabel:{color:"#7D8590"},axisLine:{lineStyle:{color:"#30363D"}}},');
H.push('yAxis:{type:"value",min:50,max:100,axisLabel:{color:"#7D8590",formatter:"{value}%"},splitLine:{lineStyle:{color:"rgba(48,54,61,0.5)"}}},');
H.push('series:[{type:"line",data:tlD.values,smooth:true,itemStyle:{color:"#27C97F"},areaStyle:{color:{type:"linear",x:0,y:0,x2:0,y2:1,colorStops:[{offset:0,color:"rgba(39,201,127,0.25)"},{offset:1,color:"rgba(39,201,127,0)"}]}},lineStyle:{width:2.5},markLine:{silent:true,data:[{yAxis:80,lineStyle:{color:"#F5A623",type:"dashed"},label:{formatter:"目标 80%",color:"#F5A623"}}]}}]});');
H.push('window.addEventListener("resize",function(){ch.resize()});});');

// Fix rate chart
H.push('var fxD='+JSON.stringify(fixTrend)+';');
H.push('["10月","11月","12月"].forEach(function(m){');
H.push('var dom=document.getElementById("fixChart-"+m);if(!dom)return;');
H.push('var ch=echarts.init(dom);ch.setOption({tooltip:Object.assign({trigger:"axis"},tt),grid:{top:20,bottom:30,left:50,right:20},');
H.push('xAxis:{type:"category",data:fxD.labels,axisLabel:{color:"#7D8590"},axisLine:{lineStyle:{color:"#30363D"}}},');
H.push('yAxis:{type:"value",min:50,max:100,axisLabel:{color:"#7D8590",formatter:"{value}%"},splitLine:{lineStyle:{color:"rgba(48,54,61,0.5)"}}},');
H.push('series:[{type:"line",data:fxD.values,smooth:true,itemStyle:{color:"#1E6FD9"},areaStyle:{color:{type:"linear",x:0,y:0,x2:0,y2:1,colorStops:[{offset:0,color:"rgba(30,111,217,0.25)"},{offset:1,color:"rgba(30,111,217,0)"}]}},lineStyle:{width:2.5},markLine:{silent:true,data:[{yAxis:80,lineStyle:{color:"#F5A623",type:"dashed"},label:{formatter:"目标 80%",color:"#F5A623"}}]}}]});');
H.push('window.addEventListener("resize",function(){ch.resize()});});');

// P0/P1 bar chart
H.push('var p0d='+JSON.stringify(p0p1Trend)+';');
H.push('["10月","11月","12月"].forEach(function(m){');
H.push('var dom=document.getElementById("p0p1Chart-"+m);if(!dom)return;');
H.push('var ch=echarts.init(dom);ch.setOption({tooltip:Object.assign({trigger:"axis"},tt),legend:{textStyle:{color:"#7D8590"},top:0},grid:{top:40,bottom:30,left:40,right:20},');
H.push('xAxis:{type:"category",data:p0d.labels,axisLabel:{color:"#7D8590"},axisLine:{lineStyle:{color:"#30363D"}}},');
H.push('yAxis:{type:"value",minInterval:1,axisLabel:{color:"#7D8590"},splitLine:{lineStyle:{color:"rgba(48,54,61,0.5)"}}},');
H.push('series:[{name:"P0",type:"bar",data:p0d.p0,itemStyle:{color:"#E84040"},barWidth:16},{name:"P1",type:"bar",data:p0d.p1,itemStyle:{color:"#F5A623"},barWidth:16}]});');
H.push('window.addEventListener("resize",function(){ch.resize()});});');

// Status stacked bar chart
H.push('var stAll='+JSON.stringify(statusData)+';');
H.push('["10月","11月","12月"].forEach(function(m){');
H.push('var dom=document.getElementById("statusChart-"+m);if(!dom)return;var st=stAll[m];');
H.push('var ch=echarts.init(dom);ch.setOption({tooltip:Object.assign({trigger:"item"},tt),');
H.push('legend:{textStyle:{color:"#7D8590"},top:0},grid:{top:40,bottom:10,left:20,right:20},');
H.push('xAxis:{type:"value",show:false},yAxis:{type:"category",data:["处理状态"],show:false},');
H.push('series:[');
H.push('{name:"已修复",type:"bar",stack:"s",data:[st["已修复"]],itemStyle:{color:"#27C97F"},barWidth:32},');
H.push('{name:"临时解决",type:"bar",stack:"s",data:[st["临时解决"]],itemStyle:{color:"#F5A623"}},');
H.push('{name:"处理中",type:"bar",stack:"s",data:[st["处理中"]],itemStyle:{color:"#1E6FD9"}},');
H.push('{name:"挂起",type:"bar",stack:"s",data:[st["挂起"]],itemStyle:{color:"#7D8590"}},');
H.push('{name:"逾期",type:"bar",stack:"s",data:[st["逾期"]],itemStyle:{color:"#E84040"}}');
H.push(']});');
H.push('window.addEventListener("resize",function(){ch.resize()});});');

H.push('});');
H.push(SE);
H.push('</body></html>');

result = H.join("\\n");
`;

export const qualityMonthlyTemplate = {
  id: 'quality-monthly-report',
  name: '技术质量月报看板',
  description: '米多技术专业委员会 · 线上质量月报（多月切换 + ECharts 图表 + 缺陷分析 + 改进计划）',
  icon: '📊',
  tags: ['quality', 'report', 'monthly', 'dashboard'],
  requiredInputs: [] as { key: string; label: string; type: 'text' | 'password' | 'select' | 'textarea' | 'month'; placeholder?: string; helpTip?: string; required: boolean; defaultValue?: string; options?: { value: string; label: string }[] }[],
  build: () => {
    _eid = 0;

    const nodes: WorkflowNode[] = [
      {
        nodeId: 'n-trigger',
        name: '手动触发',
        nodeType: 'manual-trigger',
        config: { inputPrompt: '点击生成质量月报看板' },
        inputSlots: [],
        outputSlots: [{ slotId: 'manual-out', name: 'input', dataType: 'json', required: true }],
        position: { x: 100, y: 300 },
      },
      {
        nodeId: 'n-html',
        name: '月报看板渲染（确定性）',
        nodeType: 'script-executor',
        config: {
          language: 'javascript',
          timeoutSeconds: '30',
          code: htmlGenCode.trim(),
        },
        inputSlots: [{ slotId: 'script-in', name: 'input', dataType: 'json', required: true }],
        outputSlots: [{ slotId: 'script-out', name: 'output', dataType: 'text', required: true }],
        position: { x: 450, y: 300 },
      },
      {
        nodeId: 'n-export',
        name: '导出 HTML',
        nodeType: 'file-exporter',
        config: {
          fileFormat: 'html',
          fileName: 'quality-monthly-report-{{date}}',
        },
        inputSlots: [{ slotId: 'export-in', name: 'data', dataType: 'json', required: true }],
        outputSlots: [{ slotId: 'export-out', name: 'file', dataType: 'binary', required: true }],
        position: { x: 800, y: 300 },
      },
    ];

    const edges: WorkflowEdge[] = [
      e('n-trigger', 'manual-out', 'n-html', 'script-in'),
      e('n-html', 'script-out', 'n-export', 'export-in'),
    ];

    const variables: WorkflowVariable[] = [];
    return { nodes, edges, variables };
  },
};
