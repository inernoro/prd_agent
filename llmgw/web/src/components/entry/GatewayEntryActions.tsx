import { useState } from 'react';
import { ArrowUpRight, BookOpen, Bot, Image, Plug, RotateCcw } from 'lucide-react';
import { Link } from 'react-router-dom';
import { readQuickstartDraft } from '@/lib/quickstartDraft';

const STARTERS = [
  { label: '接入现有应用', icon: Plug, intent: '我想给现有应用接入文字对话，帮助用户解答产品使用问题。' },
  { label: '搭建知识库助手', icon: BookOpen, intent: '我想搭建团队知识库助手，根据已有文档回答同事的问题。' },
  { label: '让模型理解图片', icon: Image, intent: '我想让应用理解用户上传的图片，识别画面内容并生成文字说明。' },
  { label: '连接我的 Agent', icon: Bot, intent: '我想给自己的 Agent 接入文字模型，用来理解任务并整理执行建议。' },
];
export function GatewayIntentStarters({ onChoose, disabled }: { onChoose: (text: string) => void; disabled: boolean }) {
  return <div className="gateway-intent-starters" role="group" aria-label="从一个想法开始">
    {STARTERS.map(({ label, icon: Icon, intent }) => <button type="button" key={label} disabled={disabled} onClick={() => onChoose(intent)}><Icon size={14} aria-hidden="true" /><span>{label}</span></button>)}
  </div>;
}
export function GatewayEntryCorners({ scope, onChoose, disabled }: { scope: string | null; onChoose: (text: string) => void; disabled: boolean }) {
  const [previous] = useState(() => readQuickstartDraft(scope));
  const example = '我想搭建团队知识库助手，根据产品文档回答售后同事的问题。';
  return <footer className="gateway-entry-corners" aria-label="接入起点与帮助">
    <div className="gateway-entry-resume">
      {previous && <button type="button" disabled={disabled} title={previous.intent} onClick={() => onChoose(previous.intent)}><RotateCcw size={15} aria-hidden="true" /><span><small>继续上次的接入</small><span>{previous.intent}</span></span><ArrowUpRight size={14} aria-hidden="true" /></button>}
    </div>
    <div className="gateway-entry-shortcuts">
      <details className="gateway-entry-help">
        <summary>第一次接入？</summary>
        <div className="gateway-entry-help-body"><span>让想法先有一个起点</span><p>说说谁会使用、想完成什么。细节可以在下一步调整。</p><blockquote>{example}</blockquote><button type="button" disabled={disabled} onClick={event => { onChoose(example); const panel = event.currentTarget.closest('details'); if (panel) panel.open = false; }}>试试这句 <ArrowUpRight size={14} aria-hidden="true" /></button></div>
      </details>
      <i aria-hidden="true" />
      <Link to="/service-keys">已有密钥 <ArrowUpRight size={13} aria-hidden="true" /></Link>
    </div>
  </footer>;
}
