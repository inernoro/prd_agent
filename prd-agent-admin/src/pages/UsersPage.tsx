import { useEffect, useState } from 'react';
import { Table, Input, Select, Button, Modal, Message, InputNumber } from '@arco-design/web-react';
import type { ColumnProps } from '@arco-design/web-react/es/Table';
import { IconSearch, IconPlus, IconCopy } from '@arco-design/web-react/icon';
import { getUsers, updateUserStatus, updateUserRole, generateInviteCodes } from '../services/api';
import dayjs from 'dayjs';

const Option = Select.Option;

interface User {
  userId: string;
  username: string;
  displayName: string;
  role: string;
  status: string;
  createdAt: string;
  lastLoginAt?: string;
}

export default function UsersPage() {
  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState<User[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>();
  const [statusFilter, setStatusFilter] = useState<string>();
  const [inviteModalVisible, setInviteModalVisible] = useState(false);
  const [inviteCodes, setInviteCodes] = useState<string[]>([]);
  const [inviteCount, setInviteCount] = useState(1);

  useEffect(() => {
    loadUsers();
  }, [page, search, roleFilter, statusFilter]);

  const loadUsers = async () => {
    setLoading(true);
    try {
      const response = await getUsers({
        page,
        pageSize: 20,
        search: search || undefined,
        role: roleFilter,
        status: statusFilter,
      }) as any;

      if (response.success) {
        setUsers(response.data.items);
        setTotal(response.data.total);
      }
    } catch (error) {
      Message.error('加载用户列表失败');
    } finally {
      setLoading(false);
    }
  };

  const handleStatusChange = async (userId: string, status: string) => {
    try {
      await updateUserStatus(userId, status);
      Message.success('状态更新成功');
      loadUsers();
    } catch (error) {
      Message.error('状态更新失败');
    }
  };

  const handleRoleChange = async (userId: string, role: string) => {
    try {
      await updateUserRole(userId, role);
      Message.success('角色更新成功');
      loadUsers();
    } catch (error) {
      Message.error('角色更新失败');
    }
  };

  const handleGenerateInviteCodes = async () => {
    try {
      const response = await generateInviteCodes(inviteCount) as any;
      if (response.success) {
        setInviteCodes(response.data.codes);
        Message.success(`成功生成 ${inviteCount} 个邀请码`);
      }
    } catch (error) {
      Message.error('生成邀请码失败');
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    Message.success('已复制到剪贴板');
  };

  const columns: ColumnProps<User>[] = [
    {
      title: '用户名',
      dataIndex: 'username',
      render: (_, record) => (
        <div>
          <div style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{record.username}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{record.displayName}</div>
        </div>
      ),
    },
    {
      title: '角色',
      dataIndex: 'role',
      width: 130,
      render: (role, record) => (
        <Select
          value={role}
          onChange={(value) => handleRoleChange(record.userId, value)}
          size="small"
          style={{ width: 110 }}
        >
          <Option value="PM">产品经理</Option>
          <Option value="DEV">开发</Option>
          <Option value="QA">测试</Option>
          <Option value="ADMIN">管理员</Option>
        </Select>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: (status, record) => (
        <Select
          value={status}
          onChange={(value) => handleStatusChange(record.userId, value)}
          size="small"
          style={{ width: 90 }}
        >
          <Option value="Active">正常</Option>
          <Option value="Disabled">禁用</Option>
        </Select>
      ),
    },
    {
      title: '注册时间',
      dataIndex: 'createdAt',
      width: 160,
      render: (date) => (
        <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          {dayjs(date).format('YYYY-MM-DD HH:mm')}
        </span>
      ),
    },
    {
      title: '最后登录',
      dataIndex: 'lastLoginAt',
      width: 160,
      render: (date) => (
        <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          {date ? dayjs(date).format('YYYY-MM-DD HH:mm') : '-'}
        </span>
      ),
    },
  ];

  return (
    <div className="animate-fadeIn">
      {/* 页面标题 */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 2 }}>
            用户管理
          </h1>
          <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            共 {total} 个用户
          </p>
        </div>
        <Button type="primary" size="small" icon={<IconPlus />} onClick={() => setInviteModalVisible(true)}>
          生成邀请码
        </Button>
      </div>

      {/* 内容卡片 */}
      <div 
        className="card"
        style={{ padding: '16px' }}
      >
        {/* 筛选栏 */}
        <div className="flex gap-3 mb-4 flex-wrap">
          <Input
            placeholder="搜索用户名或昵称"
            prefix={<IconSearch style={{ color: 'var(--text-muted)' }} />}
            value={search}
            onChange={setSearch}
            style={{ width: 240 }}
            allowClear
          />
          <Select
            placeholder="角色筛选"
            allowClear
            value={roleFilter}
            onChange={setRoleFilter}
            style={{ width: 130 }}
          >
            <Option value="PM">产品经理</Option>
            <Option value="DEV">开发</Option>
            <Option value="QA">测试</Option>
            <Option value="ADMIN">管理员</Option>
          </Select>
          <Select
            placeholder="状态筛选"
            allowClear
            value={statusFilter}
            onChange={setStatusFilter}
            style={{ width: 110 }}
          >
            <Option value="Active">正常</Option>
            <Option value="Disabled">禁用</Option>
          </Select>
        </div>

        {/* 表格 */}
        <Table
          columns={columns}
          data={users}
          rowKey="userId"
          loading={loading}
          border={false}
          pagination={{
            current: page,
            total,
            pageSize: 20,
            onChange: setPage,
            showTotal: true,
          }}
        />
      </div>

      {/* 邀请码弹窗 */}
      <Modal
        title="生成邀请码"
        visible={inviteModalVisible}
        onCancel={() => {
          setInviteModalVisible(false);
          setInviteCodes([]);
        }}
        footer={null}
        style={{ maxWidth: 480 }}
      >
        <div style={{ padding: 'var(--space-4) 0' }}>
          <div className="flex gap-4 mb-5">
            <InputNumber
              min={1}
              max={50}
              value={inviteCount}
              onChange={(value) => setInviteCount(value || 1)}
              style={{ width: 120 }}
            />
            <Button type="primary" onClick={handleGenerateInviteCodes}>
              生成
            </Button>
          </div>

          {inviteCodes.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
              {inviteCodes.map((code) => (
                <div 
                  key={code} 
                  className="flex items-center justify-between"
                  style={{
                    padding: 'var(--space-3) var(--space-4)',
                    background: 'var(--bg-card)',
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--border-subtle)',
                  }}
                >
                  <code style={{ fontSize: 13, fontFamily: 'var(--font-mono)', color: 'var(--accent)' }}>
                    {code}
                  </code>
                  <Button 
                    size="mini" 
                    icon={<IconCopy />} 
                    onClick={() => copyToClipboard(code)}
                  >
                    复制
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
