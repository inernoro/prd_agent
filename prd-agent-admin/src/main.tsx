import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: '#818cf8',
          colorBgContainer: 'rgba(255, 255, 255, 0.06)',
          colorBgElevated: 'rgba(30, 30, 50, 0.95)',
          colorBorder: 'rgba(255, 255, 255, 0.12)',
          colorBorderSecondary: 'rgba(255, 255, 255, 0.08)',
          borderRadius: 12,
          colorText: '#f8fafc',
          colorTextSecondary: '#94a3b8',
          colorTextTertiary: '#64748b',
        },
        components: {
          Layout: {
            siderBg: 'transparent',
            headerBg: 'transparent',
            bodyBg: 'transparent',
          },
          Menu: {
            darkItemBg: 'transparent',
            darkSubMenuItemBg: 'transparent',
            darkItemSelectedBg: 'rgba(129, 140, 248, 0.2)',
            darkItemHoverBg: 'rgba(255, 255, 255, 0.08)',
          },
          Card: {
            colorBgContainer: 'rgba(255, 255, 255, 0.06)',
          },
          Table: {
            colorBgContainer: 'transparent',
            headerBg: 'rgba(255, 255, 255, 0.04)',
          },
          Modal: {
            contentBg: 'rgba(30, 30, 50, 0.95)',
            headerBg: 'transparent',
          },
          Select: {
            optionSelectedBg: 'rgba(129, 140, 248, 0.2)',
          },
          Button: {
            primaryShadow: '0 4px 15px rgba(129, 140, 248, 0.3)',
          },
        },
      }}
    >
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ConfigProvider>
  </React.StrictMode>
);
