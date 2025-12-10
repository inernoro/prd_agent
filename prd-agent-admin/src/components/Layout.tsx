import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Layout as AntLayout, Menu, Avatar, Dropdown } from 'antd';
import {
  DashboardOutlined,
  UserOutlined,
  SettingOutlined,
  BarChartOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
} from '@ant-design/icons';
import { useAuthStore } from '../stores/authStore';

const { Sider, Header, Content } = AntLayout;

interface LayoutProps {
  children: React.ReactNode;
}

const menuItems = [
  { key: '/', icon: <DashboardOutlined />, label: '仪表盘' },
  { key: '/users', icon: <UserOutlined />, label: '用户管理' },
  { key: '/llm-config', icon: <SettingOutlined />, label: 'LLM配置' },
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
    <AntLayout className="h-screen">
      <Sider
        trigger={null}
        collapsible
        collapsed={collapsed}
        width={220}
        className="shadow-lg"
      >
        <div className="h-16 flex items-center justify-center border-b border-white/10">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-gradient-to-r from-cyan-400 to-blue-500 rounded-lg flex items-center justify-center">
              <span className="text-white font-bold">P</span>
            </div>
            {!collapsed && (
              <span className="text-white font-semibold">PRD Agent</span>
            )}
          </div>
        </div>

        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[location.pathname]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
          style={{ marginTop: 16 }}
        />
      </Sider>

      <AntLayout>
        <Header className="bg-white px-4 flex items-center justify-between shadow-sm">
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="text-lg hover:text-primary-500 transition-colors"
          >
            {collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
          </button>

          <Dropdown menu={userMenu} placement="bottomRight">
            <div className="flex items-center gap-2 cursor-pointer hover:bg-gray-50 px-3 py-1 rounded-lg">
              <Avatar size="small" icon={<UserOutlined />} className="bg-primary-500" />
              <span className="text-gray-700">{user?.displayName}</span>
            </div>
          </Dropdown>
        </Header>

        <Content className="m-4 p-6 bg-white rounded-xl overflow-auto">
          {children}
        </Content>
      </AntLayout>
    </AntLayout>
  );
}

