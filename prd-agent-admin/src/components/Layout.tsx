import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Layout as AntLayout, Menu, Avatar, Dropdown } from 'antd';
import {
  DashboardOutlined,
  UserOutlined,
  BarChartOutlined,
  LogoutOutlined,
  DoubleLeftOutlined,
  DoubleRightOutlined,
  RobotOutlined,
  MessageOutlined,
} from '@ant-design/icons';
import { useAuthStore } from '../stores/authStore';

const { Sider, Content } = AntLayout;

interface LayoutProps {
  children: React.ReactNode;
}

const menuItems = [
  { key: '/', icon: <DashboardOutlined />, label: '仪表盘' },
  { key: '/prd-agent', icon: <MessageOutlined />, label: 'PRD Agent' },
  { key: '/users', icon: <UserOutlined />, label: '用户管理' },
  { key: '/model-manage', icon: <RobotOutlined />, label: '模型管理' },
  { key: '/stats', icon: <BarChartOutlined />, label: 'Token统计' },
];

export default function Layout({ children }: LayoutProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuthStore();
  const [collapsed, setCollapsed] = useState(false);

  const userMenu = {
    items: [
      {
        key: 'logout',
        icon: <LogoutOutlined />,
        label: '退出登录',
        onClick: logout,
      },
    ],
  };

  return (
    <AntLayout className="h-screen animated-bg">
      <Sider
        trigger={null}
        collapsible
        collapsed={collapsed}
        width={220}
        collapsedWidth={64}
      >
        <div className="flex flex-col h-full">
          <div className="h-16 flex items-center justify-center">
            <div className="flex items-center gap-3">
              <div 
                className="w-8 h-8 aspect-square flex-shrink-0 flex items-center justify-center border border-white/20"
              >
                <span className="text-white font-bold text-lg">PRD</span>
              </div>
              {!collapsed && (
                <span className="text-white font-semibold text-lg tracking-tight">Agent</span>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            <Menu
              theme="dark"
              mode="inline"
              selectedKeys={[location.pathname]}
              items={menuItems}
              onClick={({ key }) => navigate(key)}
              className="mt-2 px-3 !bg-transparent !border-e-0"
            />
          </div>

          <div className="p-3 flex flex-col gap-2">
            <Dropdown menu={userMenu} placement="topLeft" trigger={['click']}>
              <div 
                className={`flex items-center gap-3 cursor-pointer transition-all hover:bg-white/5 rounded-lg p-2 ${collapsed ? 'justify-center' : ''}`}
              >
                <Avatar shape="square" size={32} icon={<UserOutlined />} className="flex-shrink-0" style={{ backgroundColor: '#000', border: '1px solid #333' }} />
                {!collapsed && (
                  <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
                    <span style={{ color: '#e5e5e5', fontSize: '14px', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{user?.displayName || 'Admin'}</span>
                    <span style={{ color: '#6b7280', fontSize: '12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>系统管理员</span>
                  </div>
                )}
              </div>
            </Dropdown>
            
            <button
              onClick={() => setCollapsed(!collapsed)}
              className={`flex items-center text-gray-500 hover:text-white transition-colors ${collapsed ? 'justify-center py-2' : 'px-2 py-2'}`}
            >
              {collapsed ? <DoubleRightOutlined /> : <DoubleLeftOutlined />}
            </button>
          </div>
        </div>
      </Sider>

      <AntLayout>
        <Content className="p-6 overflow-auto">
          {children}
        </Content>
      </AntLayout>
    </AntLayout>
  );
}
