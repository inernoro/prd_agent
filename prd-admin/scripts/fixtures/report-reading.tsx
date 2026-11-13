import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import ReportTeamShareViewPage from '/src/pages/ReportTeamShareViewPage';
import { ThemeControl } from '/src/pages/report-agent/components/ThemeControl';
import '/src/styles/tokens.css';
import '/src/styles/tailwind.css';
createRoot(document.getElementById('root')!).render(<BrowserRouter><Routes><Route path="*" element={<div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: 16 }}><ThemeControl /><Link to="/s/report-team/fixed-sample">打开固定样本分享报告</Link></div>}/><Route path="/s/report-team/:token" element={<ReportTeamShareViewPage />}/></Routes></BrowserRouter>);
