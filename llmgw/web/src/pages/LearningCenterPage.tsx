// 学习中心：控制台里的**导航与索引**，不是教程正文的第二份拷贝。
//
// 「控制台风格调性 v1.2」迁移要点（详见
// doc/rule.platform.llm-gateway.console-design-tonality.md 原则 6 / 7）：
//   - 走 PageShell 骨架、贴边全宽；此前是自搭的 .lg-simple-page 页头 + eyebrow 小标签。
//   - 这一页性质特殊：它本身就是讲解页。做法不是把字删光，而是**换承载**——
//     十个概念原来各带一整段解释，外加一段链路综述和一段排查顺序，
//     这些成段的正文全部深链到权威教程对应章节（第 0 / 1 / 32 章）；
//     页面自己只留三样东西：一句话标题、第一条请求的三步、概念索引。
//     排查顺序收进「按 requestId 定位」旁的 HelpPopover，一点就看得到，不占版面。
//   - 索引条目本身按一次调用经过的先后排列，「它们怎么连起来」由顺序表达，
//     不再另写一段综述，也不再需要页内锚点跳转（原 .lg-topic-index 那排 chip）。
//   - 原来的步骤小字与概念正文用 --fs-micro（11px）配 1.55~1.65 行高排成句解释，
//     现已改回正文档（见 lib/typography.ts 判定口诀）；内边距 20 / 18 / 15 三种
//     统一到 CARD_BODY(14) 与 INSET_BLOCK(10)。theme.css 里那几条旧声明仍在，
//     本次只用 inline 覆盖（本任务不许动 theme.css，清理项见交付报告）。
//
// 跨模块契约：prd-api 的 GatewayDataDomainGuardTests 逐字断言本页必须出现十个概念名。
// 删索引条目前先读那个测试；此处刻意不复制那十个字面量——注释里再抄一份，
// 会让守卫在界面文案被删光之后仍然误判通过。
import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  ArrowRight, Bot, Boxes, Building2, CircleDollarSign, Cpu, FileSearch,
  KeyRound, Rocket, Server, Shuffle, UsersRound,
} from 'lucide-react';
import './LearningCenterPage.css';
import { HelpPopover, PageBody, PageHeader, PageShell, TutorialLink } from '@/components/PageShell';
import { useAuth } from '@/lib/auth';
import { canAccessPage, canUseCapability, type ConsolePage } from '@/lib/access';
import { GAP } from '@/lib/surface';
import { BODY_TEXT, HINT_TEXT, SECTION_TITLE } from '@/lib/typography';

/** 索引条目：一个概念 → 一句定位 → 控制台里对应的那一页。解释本身在教程里。 */
type Topic = {
  id: string;
  title: string;
  summary: string;
  icon: ReactNode;
  link: string;
  page: ConsolePage;
};

/** 顺序即链路：从数据边界一路排到调用留下的证据。 */
const TOPICS: Topic[] = [
  { id: 'tenant', title: '租户', summary: '数据隔离的最外层边界。', icon: <Building2 size={17} />, link: '/organization', page: 'organization' },
  { id: 'team-user', title: '团队与用户', summary: '成员关系决定谁能改什么。', icon: <UsersRound size={17} />, link: '/organization', page: 'organization' },
  { id: 'app-caller', title: 'appCaller', summary: '代表哪个业务在调用模型。', icon: <Bot size={17} />, link: '/app-callers', page: 'appCallers' },
  { id: 'service-key', title: '租户接入密钥', summary: '外部系统调用网关的凭据。', icon: <KeyRound size={17} />, link: '/service-keys', page: 'serviceKeys' },
  { id: 'logical-model', title: '公开模型（对外模型）', summary: '调用方使用的公开标识，关联一条或多条上游线路。', icon: <Boxes size={17} />, link: '/logical-models', page: 'routeConfig' },
  { id: 'model', title: '上游模型', summary: '上游提供的实际型号与协议能力。', icon: <Cpu size={17} />, link: '/models', page: 'routeConfig' },
  { id: 'provider', title: '上游（Provider）', summary: '请求实际发送到的供应方与连接配置。', icon: <Server size={17} />, link: '/platforms', page: 'routeConfig' },
  { id: 'exchange', title: 'Exchange 映射', summary: '将非标准上游协议映射成网关可调用的接口。', icon: <Shuffle size={17} />, link: '/exchanges', page: 'routeConfig' },
  { id: 'request-log', title: '请求记录', summary: '每次调用留下的证据。', icon: <FileSearch size={17} />, link: '/logs', page: 'logs' },
  { id: 'cost', title: '用量与费用', summary: '在预算与用量中核对 Gateway 估算与供应商账单。', icon: <CircleDollarSign size={17} />, link: '/usage', page: 'usage' },
];

export function LearningCenterPage() {
  const { tenant } = useAuth();
  const location = useLocation();
  useEffect(() => {
    const id = location.hash.slice(1);
    if (id === 'first-request' || id === 'existing-key' || TOPICS.some(topic => topic.id === id)) document.getElementById(id)?.scrollIntoView({ block: 'start' });
  }, [location.hash]);
  const canUseQuickstart = canAccessPage(tenant, 'quickstart');
  const canManageKeys = canUseCapability(tenant?.role, 'serviceKeyWrite');
  const canStartNew = canUseQuickstart && canManageKeys && canUseCapability(tenant?.role, 'appCallerWrite');
  const canReadLogs = canAccessPage(tenant, 'logs');

  return (
    <PageShell className="lg-learn-page">
      <PageHeader
        title="学习中心"
        subtitle="找到接入、请求排查与费用核对的入口。"
        actions={(
          <>
            <TutorialLink chapter="chapter-00">查看完整教程</TutorialLink>
            {canReadLogs ? <Link className="lg-secondary-link" to="/logs"><FileSearch size={14} />排查请求</Link> : null}
          </>
        )}
      />

      <PageBody>
        {/* id 不能删：首页的空态与费用口径注脚深链到 /learn#first-request 与各索引条目的 id。 */}
        <section id="first-request" style={anchorStyle}>
            <div style={cardHeadStyle}>
              <h2 style={SECTION_TITLE}>按任务开始</h2>
            </div>
            <div className="lg-learning-steps">
              <Step title="接入新应用">
                <small style={BODY_TEXT}>在快速接入中一次创建调用身份与密钥，并完成不调用付费上游的安全验证。</small>
                {canStartNew ? <Link to="/quickstart" style={stepLinkStyle}><Rocket size={13} />创建并验证接入 <ArrowRight size={13} /></Link> : <em style={stepFallbackStyle}>请由具备调用方与密钥管理权限的角色创建接入。</em>}
              </Step>
              <Step id="existing-key" title="使用已有密钥">
                <small style={BODY_TEXT}>使用已安全保存的密钥在应用或现有客户端中调用；真实模型请求可能计费。</small>
                {canManageKeys ? <Link to="/service-keys" style={stepLinkStyle}>核对权限与轮换 <ArrowRight size={13} /></Link> : <em style={stepFallbackStyle}>接入配置与授权范围请联系密钥签发人。</em>}
              </Step>
              <Step title="核对调用结果">
                <small style={BODY_TEXT}>{canReadLogs ? '用该次 requestId 查看请求与调用链。安全验证回执不包含真实模型结果。' : '请求证据需请求读取权限；当前角色可核对聚合用量与费用。'}</small>
                {canReadLogs ? <Link to="/logs" style={stepLinkStyle}>打开请求记录 <ArrowRight size={13} /></Link> : <Link to="/usage" style={stepLinkStyle}>查看预算与用量 <ArrowRight size={13} /></Link>}
              </Step>
            </div>

        </section>

        <section className="lg-learn-index">
          <div style={cardHeadStyle}>
            <div style={titleRowStyle}>
              <h2 style={SECTION_TITLE}>概念索引</h2>
              <HelpPopover label="概念索引">
                <div style={{ display: 'grid', gap: GAP.normal }}>
                  <p style={popoverParaStyle}>每个条目直接跳到控制台里对应的那一页；成段的概念解释在权威教程里，点右上角的教程链接读。</p>
                  <p style={popoverParaStyle}>灰色条目对应当前角色不需要进入的页面。可见范围由租户角色决定，学习中心不改变它；需要进入时请让租户管理员调整角色。</p>
                  <p style={popoverParaStyle}>排查请求时按索引的先后倒查：先在请求记录里拿到 requestId 与本次的路由结果，再回头看调用方、对外模型、线路与上游平台的配置，最后确认替换规则。不要靠改 tenantId 或绕过网关来验证。</p>
                </div>
              </HelpPopover>
            </div>
          </div>
          <div className="lg-topic-grid">
            {TOPICS.map((topic) => {
              const open = canAccessPage(tenant, topic.page);
              const body = (
                <>
                  <span className="lg-topic-icon" aria-hidden="true">{topic.icon}</span>
                  <span style={topicTextStyle}>
                    <strong style={topicTitleStyle}>{topic.title}</strong>
                    <small style={BODY_TEXT}>{topic.summary}</small>
                  </span>
                  {open ? <ArrowRight size={14} style={topicArrowStyle} /> : null}
                </>
              );
              return open ? (
                <Link key={topic.id} id={topic.id} to={topic.link} style={topicEntryStyle}>{body}</Link>
              ) : (
                <span key={topic.id} id={topic.id} aria-disabled="true" style={{ ...topicEntryStyle, opacity: 0.55 }}>{body}</span>
              );
            })}
          </div>
        </section>
      </PageBody>
    </PageShell>
  );
}

/** 步骤卡：序号 + 标题 + 一句说明 + 一个去处。字号与内边距不再吃 theme.css 的旧值。 */
function Step({ id, title, children }: { id?: string; title: string; children: ReactNode }) {
  return (
    <div id={id} style={{ scrollMarginTop: 24 }}>
      <span><strong style={stepTitleStyle}>{title}</strong>{children}</span>
    </div>
  );
}

/** 卡片内边距只允许 CARD_BODY(14)；这里额外声明 minWidth 防止网格子项被内容撑破。 */

const cardHeadStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: GAP.section,
  flexWrap: 'wrap',
  marginBottom: GAP.normal,
};

/** 标题与它旁边的 ?：details 是流内容，不能塞进 h2，只能并排放。 */
const titleRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: GAP.tight, minWidth: 0 };

/** 浮层里的 p 默认带 1em 上下外边距，会把 288px 的卡片撑散，间距交给外层 grid。 */
const popoverParaStyle: CSSProperties = { margin: 0 };

/** 步骤标题原来是 --fs-caption（12px），成句的说明原来是 --fs-micro：都提回正文档。 */
const stepTitleStyle: CSSProperties = { color: 'var(--text-primary)', fontSize: 'var(--fs-body)', fontWeight: 650 };
const stepLinkStyle: CSSProperties = { fontSize: 'var(--fs-secondary)' };
const stepFallbackStyle: CSSProperties = { ...HINT_TEXT, fontStyle: 'normal' };

/** 首页深链的落点：留出与旧 .lg-anchor-section 相同的滚动余量。 */
const anchorStyle: CSSProperties = { minWidth: 0, scrollMarginTop: 18 };

const topicEntryStyle: CSSProperties = {
  padding: '12px 0',
  borderBottom: '1px solid var(--border-subtle)',
  scrollMarginTop: 18,
  display: 'flex',
  alignItems: 'flex-start',
  gap: GAP.normal,
  minWidth: 0,
  color: 'var(--text-primary)',
  textDecoration: 'none',
};
const topicTextStyle: CSSProperties = { minWidth: 0, display: 'flex', flexDirection: 'column', gap: GAP.tight };
const topicTitleStyle: CSSProperties = { color: 'var(--text-primary)', fontSize: 'var(--fs-body)', fontWeight: 650 };
const topicArrowStyle: CSSProperties = { flex: '0 0 auto', marginLeft: 'auto', color: 'var(--text-muted)' };
