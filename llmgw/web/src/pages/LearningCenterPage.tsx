import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity, ArrowRight, Bot, Boxes, Building2, CircleDollarSign, Cpu, FileSearch,
  KeyRound, Network, Rocket, Server, Shuffle, UsersRound,
} from 'lucide-react';
import { Card } from '@/components/ui';

type Topic = {
  id: string;
  title: string;
  summary: string;
  detail: string;
  icon: ReactNode;
  link: string;
  action: string;
};

const TOPICS: Topic[] = [
  {
    id: 'tenant',
    title: '租户',
    summary: '所有业务数据的最外层隔离边界。',
    detail: '登录会话或租户接入密钥在服务端确定当前租户。请求不能通过自报 tenantId 切换到其他租户。顶部租户切换器只会切换你已有成员关系的租户。',
    icon: <Building2 size={18} />,
    link: '/organization',
    action: '查看当前组织',
  },
  {
    id: 'team-user',
    title: '团队与用户',
    summary: '用户通过成员关系加入租户，并由角色和团队获得权限。',
    detail: '用户是登录身份；membership 把用户、租户、角色和团队关联起来。团队可用于限定接入密钥的使用范围，角色决定谁能看日志、管理配置或查看费用。',
    icon: <UsersRound size={18} />,
    link: '/organization',
    action: '管理团队与成员',
  },
  {
    id: 'app-caller',
    title: 'appCaller',
    summary: '代表“哪个业务应用或功能正在调用模型”。',
    detail: 'appCaller 不是用户，也不是密钥。它把业务来源、请求类型、路由策略、模型池和预算关联起来。请求记录里的 appCaller 可帮助你回答“哪项业务产生了这次调用”。',
    icon: <Bot size={18} />,
    link: '/app-callers',
    action: '查看 appCaller',
  },
  {
    id: 'service-key',
    title: '租户接入密钥',
    summary: '外部团队、脚本和应用调用 Gateway 的凭据。',
    detail: '密钥以 gwk_ 开头，明文只在创建时展示一次。它包含协议、scope、appCaller、团队、CIDR、限流和有效期等约束。MAP 等平台内部身份不出现在租户密钥列表中。',
    icon: <KeyRound size={18} />,
    link: '/service-keys',
    action: '管理接入密钥',
  },
  {
    id: 'model-pool',
    title: '模型池',
    summary: '把一个业务需求映射到一组有优先级的可用模型。',
    detail: 'appCaller 可以绑定模型池。Gateway 根据池的策略、成员优先级、健康和能力选择实际模型。模型池解决“这类业务应该从哪些模型中选择”，不是一把新的密钥。',
    icon: <Boxes size={18} />,
    link: '/pools',
    action: '查看模型池',
  },
  {
    id: 'model',
    title: '模型',
    summary: 'Gateway 可路由的具体模型配置。',
    detail: '模型记录名称、类型、能力、价格和 Provider 关联。请求记录里的“模型”是实际执行结果；期望模型与实际模型可能因模型池、Exchange 或故障回退不同。',
    icon: <Cpu size={18} />,
    link: '/models',
    action: '查看模型',
  },
  {
    id: 'provider',
    title: 'Provider',
    summary: '模型请求真正发送到的上游平台配置。',
    detail: 'Provider 保存上游类型、地址和可用状态等连接信息。租户接入密钥用于调用 Gateway；Provider 凭据用于 Gateway 调用上游，两者不可混用，也不会在 Quickstart 中暴露。',
    icon: <Server size={18} />,
    link: '/platforms',
    action: '查看 Provider',
  },
  {
    id: 'exchange',
    title: 'Exchange',
    summary: '在路由阶段应用的模型替换或映射规则。',
    detail: 'Exchange 用于把请求中的模型表达映射到平台可执行配置。排查实际模型不一致时，应同时查看请求记录的路由信息、模型池和 Exchange，而不是只看 SDK 传入值。',
    icon: <Shuffle size={18} />,
    link: '/exchanges',
    action: '查看 Exchange',
  },
  {
    id: 'request-log',
    title: '请求记录',
    summary: '每次 Gateway 调用的可观测证据。',
    detail: '记录 requestId、时间、状态、耗时、appCaller、模型、Provider、token、费用覆盖和错误。列表为空通常表示当前租户与时间范围尚无请求，而不是页面失效。',
    icon: <FileSearch size={18} />,
    link: '/logs',
    action: '打开请求记录',
  },
  {
    id: 'cost',
    title: '用量与费用',
    summary: '费用由请求 token 与可审计价格共同估算。',
    detail: '缺价格或 token 不完整时，费用状态是 unknown，不能显示为 0。CNY 与 USD 没有可审计汇率时分别展示，不直接相加。价格覆盖率说明有多少请求具备完整估算条件。',
    icon: <CircleDollarSign size={18} />,
    link: '/usage',
    action: '查看预算与用量',
  },
];

export function LearningCenterPage() {
  return (
    <div className="lg-simple-page lg-learn-page">
      <div className="lg-page-heading">
        <div>
          <div className="lg-eyebrow">开发者文档</div>
          <h1>学习中心</h1>
          <p>先理解一条请求如何穿过 Gateway，再按术语定位配置、记录和费用。</p>
        </div>
        <Link className="lg-primary-link" to="/quickstart"><Rocket size={14} /> 直接开始接入</Link>
      </div>

      <section id="first-request" className="lg-anchor-section">
        <Card className="lg-learning-path">
          <div className="lg-learning-path-heading">
            <div><div className="lg-card-kicker"><Rocket size={15} /> 第一条请求</div><h2>从 0 到可定位，只需要三步</h2></div>
            <span>建议按顺序完成</span>
          </div>
          <div className="lg-learning-steps">
            <div><b>1</b><span><strong>创建租户接入密钥</strong><small>选择 appCaller、四协议和调用 scope，明文只保存到你的安全系统。</small><Link to="/service-keys">创建密钥 <ArrowRight size={13} /></Link></span></div>
            <div><b>2</b><span><strong>选择协议并安全直测</strong><small>Gateway 地址由部署配置自动提供；安全直测只验证鉴权与路由，不调用付费上游。</small><Link to="/quickstart">打开 Quickstart <ArrowRight size={13} /></Link></span></div>
            <div><b>3</b><span><strong>用 requestId 回查</strong><small>真实请求完成后，在请求记录中查看模型、Provider、耗时、错误和费用覆盖。</small><Link to="/logs">查看请求记录 <ArrowRight size={13} /></Link></span></div>
          </div>
        </Card>
      </section>

      <section className="lg-concept-flow" aria-labelledby="concept-flow-title">
        <div className="lg-section-heading">
          <div><div className="lg-eyebrow">完整链路</div><h2 id="concept-flow-title">这些概念如何连接</h2></div>
        </div>
        <div className="lg-concept-flow-track" aria-label="Gateway 概念关系">
          <span>租户</span><ArrowRight size={14} /><span>团队与用户</span><ArrowRight size={14} /><span>appCaller 与密钥</span><ArrowRight size={14} /><span>模型池</span><ArrowRight size={14} /><span>模型与 Provider</span><ArrowRight size={14} /><span>请求记录与费用</span>
        </div>
        <p>租户确定数据边界；用户和团队确定管理权限；appCaller 表示业务身份；密钥允许外部系统进入；模型池决定如何选模型；Provider 负责上游连接；请求记录和费用留下结果证据。</p>
      </section>

      <nav className="lg-topic-index" aria-label="学习中心术语索引">
        {TOPICS.map((topic) => <a key={topic.id} href={`#${topic.id}`}>{topic.title}</a>)}
      </nav>

      <div className="lg-topic-grid">
        {TOPICS.map((topic) => (
          <section key={topic.id} id={topic.id} className="lg-anchor-section">
            <Card className="lg-topic-card">
              <div className="lg-topic-icon">{topic.icon}</div>
              <div>
                <h2>{topic.title}</h2>
                <strong>{topic.summary}</strong>
                <p>{topic.detail}</p>
                <Link className="lg-secondary-link" to={topic.link}>{topic.action} <ArrowRight size={13} /></Link>
              </div>
            </Card>
          </section>
        ))}
      </div>

      <Card className="lg-learning-troubleshoot">
        <div><Network size={19} /><span><strong>请求没有按预期执行时</strong><small>先复制 requestId，再按“请求记录 → appCaller → 模型池 → 模型与 Provider → Exchange”的顺序排查。不要通过修改 tenantId 或绕过 Gateway 来验证。</small></span></div>
        <Link className="lg-primary-link" to="/logs">按 requestId 定位 <Activity size={14} /></Link>
      </Card>
    </div>
  );
}
