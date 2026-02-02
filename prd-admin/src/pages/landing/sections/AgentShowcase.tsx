import { useState, useEffect } from 'react';
import { cn } from '@/lib/cn';

// SVG Icons for features
const Icons = {
  // Literary Agent icons
  palette: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4.098 19.902a3.75 3.75 0 005.304 0l6.401-6.402M6.75 21A3.75 3.75 0 013 17.25V4.125C3 3.504 3.504 3 4.125 3h5.25c.621 0 1.125.504 1.125 1.125v4.072M6.75 21a3.75 3.75 0 003.75-3.75V8.197M6.75 21h13.125c.621 0 1.125-.504 1.125-1.125v-5.25c0-.621-.504-1.125-1.125-1.125h-4.072M10.5 8.197l2.88-2.88c.438-.439 1.15-.439 1.59 0l3.712 3.713c.44.44.44 1.152 0 1.59l-2.879 2.88M6.75 17.25h.008v.008H6.75v-.008z" />
    </svg>
  ),
  sparkles: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z" />
    </svg>
  ),
  pencil: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
    </svg>
  ),
  refresh: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
    </svg>
  ),
  // Visual Agent icons
  photo: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
    </svg>
  ),
  wand: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.042 21.672L13.684 16.6m0 0l-2.51 2.225.569-9.47 5.227 7.917-3.286-.672zM12 2.25V4.5m5.834.166l-1.591 1.591M20.25 10.5H18M7.757 14.743l-1.59 1.59M6 10.5H3.75m4.007-4.243l-1.59-1.59" />
    </svg>
  ),
  cursor: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.042 21.672L13.684 16.6m0 0l-2.51 2.225.569-9.47 5.227 7.917-3.286-.672zm-7.518-.267A8.25 8.25 0 1120.25 10.5M8.288 14.212A5.25 5.25 0 1117.25 10.5" />
    </svg>
  ),
  layers: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6.429 9.75L2.25 12l4.179 2.25m0-4.5l5.571 3 5.571-3m-11.142 0L2.25 7.5 12 2.25l9.75 5.25-4.179 2.25m0 0L21.75 12l-4.179 2.25m0 0l4.179 2.25L12 21.75 2.25 16.5l4.179-2.25m11.142 0l-5.571 3-5.571-3" />
    </svg>
  ),
  // PRD Agent icons
  chat: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
    </svg>
  ),
  search: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
    </svg>
  ),
  clipboard: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25zM6.75 12h.008v.008H6.75V12zm0 3h.008v.008H6.75V15zm0 3h.008v.008H6.75V18z" />
    </svg>
  ),
  chart: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
    </svg>
  ),
  // Defect Agent icons
  bug: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 12.75c1.148 0 2.278.08 3.383.237 1.037.146 1.866.966 1.866 2.013 0 3.728-2.35 6.75-5.25 6.75S6.75 18.728 6.75 15c0-1.046.83-1.867 1.866-2.013A24.204 24.204 0 0112 12.75zm0 0c2.883 0 5.647.508 8.207 1.44a23.91 23.91 0 01-1.152 6.06M12 12.75c-2.883 0-5.647.508-8.208 1.44.125 2.104.52 4.136 1.153 6.06M12 12.75a2.25 2.25 0 002.248-2.354M12 12.75a2.25 2.25 0 01-2.248-2.354M12 8.25c.995 0 1.971-.08 2.922-.236.403-.066.74-.358.795-.762a3.778 3.778 0 00-.399-2.25M12 8.25c-.995 0-1.97-.08-2.922-.236-.402-.066-.74-.358-.795-.762a3.734 3.734 0 01.4-2.253M12 8.25a2.25 2.25 0 00-2.248 2.146M12 8.25a2.25 2.25 0 012.248 2.146M8.683 5a6.032 6.032 0 01-1.155-1.002c.07-.63.27-1.222.574-1.747m.581 2.749A3.75 3.75 0 0115.318 5m0 0c.427-.283.815-.62 1.155-.999a4.471 4.471 0 00-.575-1.752M4.921 6a24.048 24.048 0 00-.392 3.314c1.668.546 3.416.914 5.223 1.082M19.08 6c.205 1.08.337 2.187.392 3.314a23.882 23.882 0 01-5.223 1.082" />
    </svg>
  ),
  flag: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 3v1.5M3 21v-6m0 0l2.77-.693a9 9 0 016.208.682l.108.054a9 9 0 006.086.71l3.114-.732a48.524 48.524 0 01-.005-10.499l-3.11.732a9 9 0 01-6.085-.711l-.108-.054a9 9 0 00-6.208-.682L3 4.5M3 15V4.5" />
    </svg>
  ),
  users: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
    </svg>
  ),
  workflow: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
    </svg>
  ),
  // Open Platform icons
  code: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
    </svg>
  ),
  key: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
    </svg>
  ),
  document: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
    </svg>
  ),
  shield: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
    </svg>
  ),
  // Lab icons
  beaker: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23-.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
    </svg>
  ),
  play: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653z" />
    </svg>
  ),
  compare: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
    </svg>
  ),
  cpu: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8.25 3v1.5M4.5 8.25H3m18 0h-1.5M4.5 12H3m18 0h-1.5m-15 3.75H3m18 0h-1.5M8.25 19.5V21M12 3v1.5m0 15V21m3.75-18v1.5m0 15V21m-9-1.5h10.5a2.25 2.25 0 002.25-2.25V6.75a2.25 2.25 0 00-2.25-2.25H6.75A2.25 2.25 0 004.5 6.75v10.5a2.25 2.25 0 002.25 2.25zm.75-12h9v9h-9v-9z" />
    </svg>
  ),
};

interface Agent {
  id: string;
  name: string;
  subtitle: string;
  description: string;
  gradient: string;
  glowColor: string;
  features: { icon: keyof typeof Icons; title: string; desc: string }[];
  mockupType: 'literary' | 'visual' | 'prd' | 'defect' | 'openplatform' | 'lab';
}

const agents: Agent[] = [
  {
    id: 'visual',
    name: '视觉创作 Agent',
    subtitle: '释放你的视觉想象力',
    description: '专业级AI图像生成工作区，从文字描述到惊艳视觉，支持文生图、图生图、局部重绘等高级功能，让创意触手可及。',
    gradient: 'from-purple-500 via-pink-500 to-rose-500',
    glowColor: 'rgba(168, 85, 247, 0.4)',
    features: [
      { icon: 'photo', title: '文生图', desc: '输入描述，AI生成高质量图像' },
      { icon: 'wand', title: '图生图', desc: '上传参考图，生成风格相似的新图' },
      { icon: 'cursor', title: '局部重绘', desc: '精准编辑图像局部区域' },
      { icon: 'layers', title: '风格融合', desc: '多风格混合，创造独特视觉' },
    ],
    mockupType: 'visual',
  },
  {
    id: 'literary',
    name: '文学创作 Agent',
    subtitle: '为您的文字插上翅膀',
    description: '智能文章配图与文学润色，一键生成与文章内容完美契合的插画，支持多种艺术风格，让每篇文章都成为视觉盛宴。',
    gradient: 'from-amber-500 via-orange-500 to-red-500',
    glowColor: 'rgba(251, 146, 60, 0.4)',
    features: [
      { icon: 'palette', title: '智能配图', desc: '基于文章内容自动生成契合的插画' },
      { icon: 'sparkles', title: '风格迁移', desc: '支持水彩、油画、素描等20+艺术风格' },
      { icon: 'pencil', title: '文学润色', desc: 'AI辅助改写，提升文章表达力' },
      { icon: 'refresh', title: '批量处理', desc: '一键为整篇文章生成系列配图' },
    ],
    mockupType: 'literary',
  },
  {
    id: 'prd',
    name: 'PRD Agent',
    subtitle: '让需求文档触手可及',
    description: '智能需求文档解读与问答系统，上传PRD即可与AI对话，快速理解需求细节、发现文档缺失、生成测试用例。',
    gradient: 'from-blue-500 via-cyan-500 to-teal-500',
    glowColor: 'rgba(59, 130, 246, 0.4)',
    features: [
      { icon: 'chat', title: '智能问答', desc: '基于PRD内容回答任何问题' },
      { icon: 'search', title: '缺失检测', desc: '自动发现需求文档中的遗漏' },
      { icon: 'clipboard', title: '用例生成', desc: '一键生成测试用例和验收标准' },
      { icon: 'chart', title: '需求摘要', desc: '快速生成PRD核心要点总结' },
    ],
    mockupType: 'prd',
  },
  {
    id: 'defect',
    name: '缺陷管理 Agent',
    subtitle: '让Bug无处遁形',
    description: '智能缺陷分析与管理助手，可视化缺陷看板、智能分配、状态追踪，AI驱动的缺陷全生命周期管理。',
    gradient: 'from-emerald-500 via-green-500 to-lime-500',
    glowColor: 'rgba(16, 185, 129, 0.4)',
    features: [
      { icon: 'bug', title: '缺陷看板', desc: '可视化管理所有缺陷状态' },
      { icon: 'flag', title: '优先级管理', desc: '智能评估严重程度和优先级' },
      { icon: 'users', title: '智能分配', desc: '根据技能自动分配处理人' },
      { icon: 'workflow', title: '流程追踪', desc: '完整的缺陷生命周期管理' },
    ],
    mockupType: 'defect',
  },
  {
    id: 'openplatform',
    name: '开放平台',
    subtitle: 'API赋能万物互联',
    description: '标准化API接口，让您的系统轻松接入AI能力。完善的文档、SDK和调用日志，助力快速集成与调试。',
    gradient: 'from-indigo-500 via-violet-500 to-purple-500',
    glowColor: 'rgba(99, 102, 241, 0.4)',
    features: [
      { icon: 'code', title: 'RESTful API', desc: '标准接口，多语言SDK支持' },
      { icon: 'key', title: '密钥管理', desc: '安全的API密钥与权限控制' },
      { icon: 'document', title: '完善文档', desc: '详细的接口文档与示例代码' },
      { icon: 'shield', title: '调用日志', desc: '实时监控API调用与计费' },
    ],
    mockupType: 'openplatform',
  },
  {
    id: 'lab',
    name: '实验室',
    subtitle: '探索AI的无限可能',
    description: '大模型实验平台，支持多模型并行测试、性能对比、参数调优。是开发者和研究者的AI探索工具。',
    gradient: 'from-rose-500 via-red-500 to-orange-500',
    glowColor: 'rgba(244, 63, 94, 0.4)',
    features: [
      { icon: 'beaker', title: '实验配置', desc: '灵活配置实验参数与模型组合' },
      { icon: 'play', title: '一键运行', desc: '批量执行实验，自动记录结果' },
      { icon: 'compare', title: '对比分析', desc: '多模型输出并排对比展示' },
      { icon: 'cpu', title: '性能监控', desc: 'TTFT、总时长等指标实时监控' },
    ],
    mockupType: 'lab',
  },
];

// Mock UI components for each agent type
function AgentMockup({ type, isActive }: { type: Agent['mockupType']; isActive: boolean }) {
  const baseClass = cn(
    'w-full h-full overflow-hidden transition-all duration-700',
    isActive ? 'opacity-100 scale-100' : 'opacity-0 scale-95'
  );

  if (type === 'visual') {
    return (
      <div className={baseClass}>
        <div className="h-full bg-[#1e2128] flex">
          {/* Left sidebar - tools */}
          <div className="w-10 bg-[#282c34] flex flex-col items-center py-3 gap-2 border-r border-white/10">
            {['cursor', 'plus', 'square', 'text', 'image'].map((_, i) => (
              <div key={i} className={cn('w-6 h-6 rounded flex items-center justify-center', i === 0 ? 'bg-white/10' : 'bg-white/5')}>
                <div className="w-3 h-3 border border-white/40 rounded-sm" />
              </div>
            ))}
          </div>

          {/* Center - Canvas with images */}
          <div className="flex-1 p-3 relative bg-[#1a1d24]">
            {/* Toolbar */}
            <div className="absolute top-2 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-black/40 rounded px-2 py-1 text-[10px] text-white/50">
              <span>14%</span>
              <span>适配</span>
              <span>100%</span>
            </div>

            {/* Image grid */}
            <div className="h-full pt-6 grid grid-cols-4 gap-1.5 content-start auto-rows-min">
              <div className="col-span-1 h-10 rounded bg-gradient-to-br from-amber-700/60 to-amber-900/60 border border-white/10" />
              <div className="col-span-2 row-span-2 h-24 rounded bg-gradient-to-br from-green-600/50 to-green-800/50 border border-white/10" />
              <div className="col-span-1 h-12 rounded bg-gradient-to-br from-orange-600/50 to-orange-800/50 border border-white/10" />
              <div className="col-span-1 h-10 rounded bg-gradient-to-br from-gray-600/50 to-gray-800/50 border border-white/10" />
              <div className="col-span-1 h-14 rounded bg-gradient-to-br from-teal-600/50 to-teal-800/50 border border-white/10" />
              <div className="col-span-2 h-20 rounded bg-gradient-to-br from-emerald-600/40 to-emerald-800/40 border border-white/10 relative">
                <div className="absolute bottom-1 right-1 text-[8px] text-purple-400/40">米多AI生成</div>
              </div>
              <div className="col-span-2 h-20 rounded bg-gradient-to-br from-lime-600/40 to-lime-800/40 border border-white/10 relative">
                <div className="absolute bottom-1 right-1 text-[8px] text-purple-400/40">米多AI生成</div>
              </div>
              <div className="col-span-1 h-12 rounded bg-gradient-to-br from-cyan-600/50 to-cyan-800/50 border border-white/10" />
              <div className="col-span-1 h-12 rounded bg-gradient-to-br from-blue-600/50 to-blue-800/50 border border-white/10" />
            </div>
          </div>

          {/* Right - Chat panel */}
          <div className="w-44 bg-[#282c34] border-l border-white/10 flex flex-col text-[10px]">
            <div className="p-2 border-b border-white/10">
              <div className="text-white/80">Hi，我是你的 AI 设计师</div>
              <div className="text-white/40 mt-0.5 text-[9px]">点画板图片即可选中...</div>
            </div>
            <div className="flex-1 p-2 space-y-2 overflow-hidden">
              <div className="bg-white/5 rounded p-1.5">
                <div className="flex items-center gap-1 mb-1">
                  <span className="px-1 py-0.5 rounded bg-blue-500/20 text-blue-400 text-[8px]">1K·1:1</span>
                  <span className="text-purple-400 text-[8px]">nano-banana</span>
                </div>
                <div className="h-12 rounded bg-gradient-to-br from-green-600/30 to-green-800/30 border border-white/10" />
              </div>
              <div className="bg-white/5 rounded p-1.5">
                <span className="text-emerald-400">站起来</span>
                <span className="ml-1 px-1 py-0.5 rounded bg-white/10 text-white/50 text-[8px]">重试</span>
              </div>
            </div>
            <div className="p-2 border-t border-white/10">
              <div className="h-6 rounded bg-white/5 border border-white/10 flex items-center px-2 text-white/30">
                请输入设计需求...
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (type === 'literary') {
    return (
      <div className={baseClass}>
        <div className="h-full bg-gradient-to-br from-[#1a1a1f] to-[#0d0d10] p-4 flex gap-4">
          <div className="flex-1 space-y-3">
            <div className="h-2.5 w-28 bg-white/20 rounded" />
            <div className="space-y-1.5">
              {[100, 80, 100, 75, 90].map((w, i) => (
                <div key={i} className="h-1.5 bg-white/10 rounded" style={{ width: `${w}%` }} />
              ))}
            </div>
            <div className="h-24 rounded-lg bg-gradient-to-br from-amber-500/20 to-orange-500/20 border border-amber-500/30 flex items-center justify-center">
              <span className="text-amber-400/60 text-xs">AI 配图生成中...</span>
            </div>
            <div className="space-y-1.5">
              {[100, 85].map((w, i) => (
                <div key={i} className="h-1.5 bg-white/10 rounded" style={{ width: `${w}%` }} />
              ))}
            </div>
          </div>
          <div className="w-36 space-y-2">
            <div className="text-[10px] text-white/40">生成的配图</div>
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-14 rounded-lg bg-gradient-to-br from-amber-500/30 to-orange-600/30 border border-amber-500/20 animate-pulse" style={{ animationDelay: `${i * 200}ms` }} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (type === 'prd') {
    return (
      <div className={baseClass}>
        <div className="h-full bg-gradient-to-br from-[#1a1a1f] to-[#0d0d10] p-4 flex gap-3">
          <div className="w-1/2 rounded-lg border border-white/10 bg-black/20 p-3 space-y-2">
            <div className="flex items-center gap-2 pb-2 border-b border-white/10">
              <div className="w-2.5 h-2.5 rounded bg-blue-500" />
              <span className="text-[10px] text-white/60">PRD文档.pdf</span>
            </div>
            <div className="space-y-1.5">
              {[70, 90, 65, 85, 75, 80].map((w, i) => (
                <div key={i} className="h-1.5 bg-white/10 rounded" style={{ width: `${w}%` }} />
              ))}
            </div>
            <div className="h-12 rounded bg-blue-500/10 border border-blue-500/30 flex items-center justify-center">
              <span className="text-blue-400/60 text-[9px]">高亮: 第3.2节 用户登录流程</span>
            </div>
          </div>
          <div className="flex-1 rounded-lg border border-white/10 bg-black/20 p-3 flex flex-col">
            <div className="flex-1 space-y-2">
              <div className="flex justify-end">
                <div className="bg-blue-500/20 rounded px-2 py-1.5 text-[10px] text-white/70 max-w-[85%]">
                  登录失败后的处理逻辑是什么？
                </div>
              </div>
              <div className="flex justify-start">
                <div className="bg-white/5 rounded px-2 py-1.5 text-[10px] text-white/60 max-w-[85%]">
                  根据PRD第3.2.4节，登录失败后...
                </div>
              </div>
            </div>
            <div className="mt-2 h-6 rounded bg-white/5 border border-white/10" />
          </div>
        </div>
      </div>
    );
  }

  if (type === 'defect') {
    // Defect Agent - Card-based kanban view matching the screenshot
    return (
      <div className={baseClass}>
        <div className="h-full bg-[#1a1d24] flex">
          {/* Left sidebar */}
          <div className="w-40 bg-[#14171c] border-r border-white/10 p-3 space-y-1 text-[10px]">
            {['仪表盘', '用户管理', '群组管理', '模型管理', '提示词管理', 'PRD Agent', '缺陷管理 Agent', '视觉创作 Agent'].map((item, i) => (
              <div key={i} className={cn('px-2 py-1.5 rounded flex items-center gap-2', i === 6 ? 'bg-white/10 text-white' : 'text-white/50')}>
                <div className="w-3 h-3 rounded bg-white/20" />
                {item}
              </div>
            ))}
          </div>

          {/* Main content - Defect cards */}
          <div className="flex-1 p-4">
            {/* Header */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex gap-2">
                <span className="px-2 py-1 rounded bg-white/5 text-[10px] text-white/60">收到</span>
                <span className="px-2 py-1 rounded bg-white/10 text-[10px] text-white/80 border border-white/20">我提交的</span>
              </div>
              <div className="flex gap-2">
                <span className="px-2 py-1 rounded bg-white/5 text-[10px] text-white/50">我的模板</span>
                <span className="px-2 py-1 rounded bg-emerald-500/20 text-[10px] text-emerald-400">+ 提交缺陷</span>
              </div>
            </div>

            {/* Defect cards */}
            <div className="grid grid-cols-2 gap-3">
              {/* Card 1 */}
              <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="px-1.5 py-0.5 rounded text-[8px] bg-emerald-500/20 text-emerald-400">已读</span>
                  <span className="text-[9px] text-white/40">DEF-2026-0002</span>
                </div>
                <div className="text-[11px] text-white/80 mb-2">生图不了？</div>
                <div className="text-[10px] text-white/50 mb-2">我哪知道</div>
                <div className="h-8 w-8 rounded bg-white/10 mb-2" />
                <div className="flex items-center gap-2 text-[9px]">
                  <span className="px-1.5 py-0.5 rounded bg-green-500/20 text-green-400">轻微</span>
                  <span className="text-white/40">管理员 → 刘文波</span>
                </div>
              </div>

              {/* Card 2 */}
              <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="px-1.5 py-0.5 rounded text-[8px] bg-blue-500/20 text-blue-400">对方已读</span>
                  <span className="text-[9px] text-white/40">DEF-2026-0001</span>
                </div>
                <div className="text-[11px] text-white/80 mb-2">图片老是...</div>
                <div className="text-[10px] text-white/50 mb-2">修好了通知我</div>
                <div className="flex gap-1 mb-2">
                  <div className="h-8 w-8 rounded bg-white/10" />
                  <div className="h-8 w-8 rounded bg-white/10" />
                </div>
                <div className="flex items-center gap-2 text-[9px]">
                  <span className="px-1.5 py-0.5 rounded bg-green-500/20 text-green-400">轻微</span>
                  <span className="text-white/40">管理员</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (type === 'openplatform') {
    return (
      <div className={baseClass}>
        <div className="h-full bg-[#1a1d24] flex">
          {/* Sidebar */}
          <div className="w-36 bg-[#14171c] border-r border-white/10 p-3 text-[10px]">
            <div className="text-white/40 mb-2">开放平台</div>
            {['应用管理', 'API密钥', '调用日志', '计费详情', '开发文档'].map((item, i) => (
              <div key={i} className={cn('px-2 py-1.5 rounded mb-1', i === 0 ? 'bg-white/10 text-white' : 'text-white/50')}>
                {item}
              </div>
            ))}
          </div>

          {/* Main content */}
          <div className="flex-1 p-4">
            <div className="text-sm text-white/80 mb-4">我的应用</div>

            {/* App cards */}
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-500" />
                  <div>
                    <div className="text-[11px] text-white/80">生产环境</div>
                    <div className="text-[9px] text-white/40">app-prod-xxx</div>
                  </div>
                </div>
                <div className="flex gap-2 text-[9px]">
                  <span className="px-1.5 py-0.5 rounded bg-green-500/20 text-green-400">运行中</span>
                  <span className="text-white/40">12,580 次调用</span>
                </div>
              </div>

              <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-orange-500 to-red-500" />
                  <div>
                    <div className="text-[11px] text-white/80">测试环境</div>
                    <div className="text-[9px] text-white/40">app-test-xxx</div>
                  </div>
                </div>
                <div className="flex gap-2 text-[9px]">
                  <span className="px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-400">调试中</span>
                  <span className="text-white/40">256 次调用</span>
                </div>
              </div>
            </div>

            {/* API usage chart placeholder */}
            <div className="mt-4 rounded-lg border border-white/10 bg-white/[0.02] p-3">
              <div className="text-[10px] text-white/60 mb-2">今日调用趋势</div>
              <div className="h-16 flex items-end gap-1">
                {[40, 65, 45, 80, 60, 90, 70, 55, 85, 50].map((h, i) => (
                  <div key={i} className="flex-1 bg-indigo-500/40 rounded-t" style={{ height: `${h}%` }} />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (type === 'lab') {
    // Lab - Model experiment interface matching the screenshot
    return (
      <div className={baseClass}>
        <div className="h-full bg-[#1a1d24] flex">
          {/* Sidebar */}
          <div className="w-36 bg-[#14171c] border-r border-white/10 p-3 text-[10px]">
            {['PRD Agent', '缺陷管理 Agent', '视觉创作 Agent', '文学创作 Agent', '资源管理', '请求日志', '数据管理', '系统设置', '开放平台', '权限管理', '实验室'].map((item, i) => (
              <div key={i} className={cn('px-2 py-1.5 rounded mb-1', i === 10 ? 'bg-white/10 text-white' : 'text-white/50')}>
                {item}
              </div>
            ))}
          </div>

          {/* Main content */}
          <div className="flex-1 p-4 flex gap-4">
            {/* Left panel - Config */}
            <div className="w-44 space-y-3">
              {/* Tabs */}
              <div className="flex gap-2 text-[10px]">
                <span className="text-white/40">试验车间</span>
                <span className="px-2 py-1 rounded bg-white/10 text-white">大模型实验室</span>
                <span className="text-white/40">桌面实验室</span>
              </div>

              {/* Experiment area */}
              <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] text-white/60">试验区</span>
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400">+ 新建</span>
                </div>
                <div className="text-[9px] text-white/40 mb-2">保存实验配置与历史 (Mongo)</div>
                <div className="bg-white/5 rounded p-2 text-[10px] text-white/70">默认实验</div>
              </div>

              {/* Model selection */}
              <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
                <div className="text-[10px] text-white/60 mb-2">大模型实验</div>
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2 text-[9px]">
                    <div className="w-2 h-2 rounded-full bg-orange-500" />
                    <span className="text-orange-400">火山引擎</span>
                    <span className="text-white/40">1个</span>
                  </div>
                  <div className="bg-white/5 rounded px-2 py-1 text-[9px] text-white/60">
                    doubao-seedream-4-5
                  </div>
                  <div className="flex items-center gap-2 text-[9px]">
                    <div className="w-2 h-2 rounded-full bg-green-500" />
                    <span className="text-green-400">蒙着安</span>
                    <span className="text-white/40">1个</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Right panel - Results */}
            <div className="flex-1 space-y-3">
              {/* Input type tabs */}
              <div className="flex gap-2 text-[9px]">
                {['推理', '生图', '意图', 'JSON', 'MCP', 'FunctionCall', '生图意图'].map((tab, i) => (
                  <span key={i} className={cn('px-2 py-1 rounded', i === 2 ? 'bg-white/10 text-white' : 'bg-white/5 text-white/50')}>
                    {tab}
                  </span>
                ))}
                <span className="ml-auto px-2 py-1 rounded bg-blue-500/20 text-blue-400">▶ 一键开始实验</span>
              </div>

              {/* Prompt input */}
              <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
                <div className="text-[9px] text-white/40 mb-1">当前：推理 · 类型：意图</div>
                <div className="text-[10px] text-white/60">用户输入</div>
                <div className="mt-2 text-[9px] text-white/50 leading-relaxed">
                  A premium, technical blueprint-style illustration about the "Open Platform"...
                </div>
              </div>

              {/* Results area */}
              <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] text-white/60">实时结果（按首字延迟排序）</span>
                  <div className="flex gap-2 text-[9px]">
                    <span className="px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400">首字延迟</span>
                    <span className="text-white/40">总时长</span>
                  </div>
                </div>
                <div className="h-20 flex items-center justify-center text-white/30 text-[10px]">
                  点击"一键开始实验"查看对比结果
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return null;
}

interface AgentShowcaseProps {
  className?: string;
}

export function AgentShowcase({ className }: AgentShowcaseProps) {
  const [activeIndex, setActiveIndex] = useState(0);

  // Auto-rotate every 6 seconds
  useEffect(() => {
    const timer = setInterval(() => {
      setActiveIndex((prev) => (prev + 1) % agents.length);
    }, 6000);
    return () => clearInterval(timer);
  }, []);

  const activeAgent = agents[activeIndex];

  return (
    <section className={cn('relative py-24 sm:py-32 overflow-hidden', className)}>
      {/* Background */}
      <div className="absolute inset-0 bg-[#050508]" />

      {/* Dynamic glow based on active agent */}
      <div
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] rounded-full blur-[150px] transition-all duration-1000"
        style={{ background: activeAgent.glowColor, opacity: 0.3 }}
      />

      {/* Content */}
      <div className="relative z-10 max-w-7xl mx-auto px-6">
        {/* Section header */}
        <div className="text-center mb-16">
          <div className="inline-flex items-center gap-2 px-4 py-2 mb-6 rounded-full border border-white/10 bg-white/[0.03]">
            <span className="text-sm text-white/50">六大核心产品</span>
          </div>
          <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold text-white/90 mb-4">
            为不同场景量身定制
          </h2>
          <p className="text-lg text-white/40 max-w-2xl mx-auto">
            覆盖创作、设计、需求、质量、开发全流程的 AI 助手矩阵
          </p>
        </div>

        {/* Agent tabs */}
        <div className="flex justify-center gap-2 mb-12 flex-wrap">
          {agents.map((agent, index) => (
            <button
              key={agent.id}
              onClick={() => setActiveIndex(index)}
              className={cn(
                'px-4 py-2 rounded-full text-sm font-medium transition-all duration-300',
                index === activeIndex
                  ? 'bg-white/10 text-white border border-white/20'
                  : 'text-white/50 hover:text-white/70 hover:bg-white/5'
              )}
            >
              {agent.name}
            </button>
          ))}
        </div>

        {/* Main showcase area */}
        <div className="grid lg:grid-cols-2 gap-8 lg:gap-12 items-center">
          {/* Left: Info */}
          <div className="order-2 lg:order-1">
            <div
              className={cn(
                'inline-block px-3 py-1 rounded-full text-xs font-medium mb-4 bg-gradient-to-r',
                activeAgent.gradient
              )}
            >
              {activeAgent.subtitle}
            </div>

            <h3 className="text-3xl sm:text-4xl font-bold text-white/90 mb-4">
              {activeAgent.name}
            </h3>

            <p className="text-white/50 mb-8 leading-relaxed">
              {activeAgent.description}
            </p>

            {/* Features grid */}
            <div className="grid grid-cols-2 gap-4 mb-8">
              {activeAgent.features.map((feature, i) => (
                <div
                  key={i}
                  className="p-4 rounded-xl bg-white/[0.03] border border-white/10 hover:bg-white/[0.05] hover:border-white/20 transition-all duration-300"
                >
                  <div className={cn('inline-flex p-2 rounded-lg mb-2 bg-gradient-to-br', activeAgent.gradient)}>
                    {Icons[feature.icon]}
                  </div>
                  <div className="text-sm font-medium text-white/80 mb-1">{feature.title}</div>
                  <div className="text-xs text-white/40">{feature.desc}</div>
                </div>
              ))}
            </div>

            {/* CTA */}
            <button
              className={cn(
                'px-6 py-3 rounded-xl font-medium text-white transition-all duration-300 hover:scale-105 active:scale-95 bg-gradient-to-r',
                activeAgent.gradient
              )}
              style={{
                boxShadow: `0 0 30px ${activeAgent.glowColor}`,
              }}
            >
              开始使用 {activeAgent.name}
            </button>
          </div>

          {/* Right: Mockup */}
          <div className="order-1 lg:order-2">
            <div
              className="relative aspect-[4/3] rounded-2xl overflow-hidden border border-white/10"
              style={{
                boxShadow: `0 0 60px ${activeAgent.glowColor}, 0 25px 50px -12px rgba(0,0,0,0.5)`,
              }}
            >
              {/* Window chrome */}
              <div className="absolute top-0 left-0 right-0 h-7 bg-black/50 backdrop-blur-sm flex items-center px-3 gap-1.5 z-10">
                <div className="w-2.5 h-2.5 rounded-full bg-red-500/80" />
                <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/80" />
                <div className="w-2.5 h-2.5 rounded-full bg-green-500/80" />
              </div>

              {/* Mockup content */}
              <div className="pt-7 h-full">
                {agents.map((agent, index) => (
                  <div
                    key={agent.id}
                    className={cn(
                      'absolute inset-0 pt-7 transition-all duration-700',
                      index === activeIndex ? 'opacity-100' : 'opacity-0 pointer-events-none'
                    )}
                  >
                    <AgentMockup type={agent.mockupType} isActive={index === activeIndex} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Progress indicators */}
        <div className="flex justify-center gap-2 mt-12">
          {agents.map((_, index) => (
            <button
              key={index}
              onClick={() => setActiveIndex(index)}
              className={cn(
                'h-1.5 rounded-full transition-all duration-500',
                index === activeIndex ? 'w-8 bg-white/60' : 'w-1.5 bg-white/20 hover:bg-white/30'
              )}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
