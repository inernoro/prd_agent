import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Layout as ArcoLayout, Menu, Avatar, Dropdown } from '@arco-design/web-react';
import {
  IconDashboard,
  IconUser,
  IconRobot,
  IconFire,
  IconExport,
  IconMenuFold,
  IconMenuUnfold,
} from '@arco-design/web-react/icon';
import { useAuthStore } from '../stores/authStore';

const { Sider, Content } = ArcoLayout;
const MenuItem = Menu.Item;

interface LayoutProps {
  children: React.ReactNode;
}

const menuItems = [
  { key: '/', icon: <IconDashboard />, label: '仪表盘' },
  { key: '/users', icon: <IconUser />, label: '用户管理' },
  { key: '/model-manage', icon: <IconRobot />, label: '模型管理' },
  { key: '/stats', icon: <IconFire />, label: 'Token统计' },
];

export default function Layout({ children }: LayoutProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuthStore();
  const [collapsed, setCollapsed] = useState(false);

  const dropList = (
    <Menu onClickMenuItem={(key) => {
      if (key === 'logout') logout();
    }}>
      <MenuItem key="logout">
        <IconExport style={{ marginRight: 8 }} />
        退出登录
      </MenuItem>
    </Menu>
  );

  return (
    <ArcoLayout className="h-full">
      {/* 侧边栏 */}
      <Sider
        className={`admin-sider ${collapsed ? 'is-collapsed' : ''}`}
        collapsed={collapsed}
        collapsible
        trigger={null}
        width={200}
        collapsedWidth={64}
        style={{
          background: 'var(--bg-elevated)',
          borderRight: '1px solid var(--border-subtle)',
        }}
      >
        <div className="admin-sider-container">
          {/* Logo */}
          <div className={`admin-sider-logo ${collapsed ? 'is-collapsed' : ''}`}>
            <div className="admin-sider-logo-icon">
              <span>PRD</span>
            </div>
            {!collapsed && (
              <span className="admin-sider-logo-text">Agent</span>
            )}
          </div>

          {/* 菜单 */}
          <div className="admin-sider-menu-wrapper">
            <Menu
              className="admin-sider-menu"
              mode="vertical"
              selectedKeys={[location.pathname]}
              onClickMenuItem={(key) => navigate(key)}
            >
              {menuItems.map((item) => (
                <MenuItem 
                  key={item.key}
                  className="admin-sider-menu-item"
                >
                  <span className="admin-sider-menu-item-inner">
                    <span className="sidebar-icon">{item.icon}</span>
                    {!collapsed && <span className="sidebar-label">{item.label}</span>}
                  </span>
                </MenuItem>
              ))}
            </Menu>
          </div>

          {/* 底部区域 */}
          <div className="admin-sider-footer">
            {/* 用户信息 */}
            <Dropdown droplist={dropList} position="top" trigger="click">
              <div className={`admin-sider-user ${collapsed ? 'is-collapsed' : ''}`}>
                <Avatar 
                  size={28} 
                  className="admin-sider-user-avatar"
                >
                  {(user?.displayName || 'A').charAt(0).toUpperCase()}
                </Avatar>
                {!collapsed && (
                  <div className="admin-sider-user-info">
                    <div className="admin-sider-user-name">
                      {user?.displayName || 'Admin'}
                    </div>
                    <div className="admin-sider-user-role">
                      系统管理员
                    </div>
                  </div>
                )}
              </div>
            </Dropdown>

            {/* 折叠按钮 */}
            <button
              onClick={() => setCollapsed(!collapsed)}
              className="admin-sider-toggle"
              type="button"
            >
              {collapsed ? (
                <IconMenuUnfold style={{ fontSize: 16 }} />
              ) : (
                <IconMenuFold style={{ fontSize: 16 }} />
              )}
            </button>
          </div>
        </div>
      </Sider>

      {/* 主内容区 */}
      <ArcoLayout>
        <Content className="admin-content">
          {children}
        </Content>
      </ArcoLayout>
    </ArcoLayout>
  );
}
