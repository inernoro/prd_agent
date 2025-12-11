import { useEffect, useState } from 'react';
import { Table, Card, Input, Select, Button, Modal, message, InputNumber } from 'antd';
import { SearchOutlined, PlusOutlined, CopyOutlined } from '@ant-design/icons';
import { getUsers, updateUserStatus, updateUserRole, generateInviteCodes } from '../services/api';
import dayjs from 'dayjs';

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
      message.error('加载用户列表失败');
    } finally {
      setLoading(false);
    }
  };

  const handleStatusChange = async (userId: string, status: string) => {
    try {
      await updateUserStatus(userId, status);
      message.success('状态更新成功');
      loadUsers();
    } catch (error) {
      message.error('状态更新失败');
    }
  };

  const handleRoleChange = async (userId: string, role: string) => {
    try {
      await updateUserRole(userId, role);
      message.success('角色更新成功');
      loadUsers();
    } catch (error) {
      message.error('角色更新失败');
    }
  };

  const handleGenerateInviteCodes = async () => {
    try {
      const response = await generateInviteCodes(inviteCount) as any;
      if (response.success) {
        setInviteCodes(response.data.codes);
        message.success(`成功生成 ${inviteCount} 个邀请码`);
      }
    } catch (error) {
      message.error('生成邀请码失败');
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    message.success('已复制到剪贴板');
  };

  const columns = [
    {
      title: '用户名',
      dataIndex: 'username',
      key: 'username',
      render: (text: string, record: User) => (
        <div>
          <div className="font-medium">{text}</div>
          <div className="text-xs text-gray-500">{record.displayName}</div>
        </div>
      ),
    },
    {
      title: '角色',
      dataIndex: 'role',
      key: 'role',
      render: (role: string, record: User) => (
        <Select
          value={role}
          onChange={(value) => handleRoleChange(record.userId, value)}
          style={{ width: 110 }}
          size="small"
        >
          <Select.Option value="PM">产品经理</Select.Option>
          <Select.Option value="DEV">开发</Select.Option>
          <Select.Option value="QA">测试</Select.Option>
          <Select.Option value="ADMIN">管理员</Select.Option>
        </Select>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (status: string, record: User) => (
        <Select
          value={status}
          onChange={(value) => handleStatusChange(record.userId, value)}
          style={{ width: 90 }}
          size="small"
        >
          <Select.Option value="Active">正常</Select.Option>
          <Select.Option value="Disabled">禁用</Select.Option>
        </Select>
      ),
    },
    {
      title: '注册时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (date: string) => dayjs(date).format('YYYY-MM-DD HH:mm'),
    },
    {
      title: '最后登录',
      dataIndex: 'lastLoginAt',
      key: 'lastLoginAt',
      render: (date?: string) => date ? dayjs(date).format('YYYY-MM-DD HH:mm') : '-',
    },
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">用户管理</h1>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setInviteModalVisible(true)}>
          生成邀请码
        </Button>
      </div>

      <Card>
        <div className="flex gap-4 mb-4 flex-wrap">
          <Input
            placeholder="搜索用户名或昵称"
            prefix={<SearchOutlined />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 240 }}
          />
          <Select
            placeholder="角色筛选"
            allowClear
            value={roleFilter}
            onChange={setRoleFilter}
            style={{ width: 120 }}
          >
            <Select.Option value="PM">产品经理</Select.Option>
            <Select.Option value="DEV">开发</Select.Option>
            <Select.Option value="QA">测试</Select.Option>
            <Select.Option value="ADMIN">管理员</Select.Option>
          </Select>
          <Select
            placeholder="状态筛选"
            allowClear
            value={statusFilter}
            onChange={setStatusFilter}
            style={{ width: 100 }}
          >
            <Select.Option value="Active">正常</Select.Option>
            <Select.Option value="Disabled">禁用</Select.Option>
          </Select>
        </div>

        <Table
          columns={columns}
          dataSource={users}
          rowKey="userId"
          loading={loading}
          pagination={{
            current: page,
            total,
            pageSize: 20,
            onChange: setPage,
            showTotal: (total) => `共 ${total} 条`,
          }}
        />
      </Card>

      <Modal
        title="生成邀请码"
        open={inviteModalVisible}
        onCancel={() => {
          setInviteModalVisible(false);
          setInviteCodes([]);
        }}
        footer={null}
      >
        <div className="py-4">
          <div className="flex gap-4 mb-4">
            <InputNumber
              min={1}
              max={50}
              value={inviteCount}
              onChange={(value) => setInviteCount(value || 1)}
              addonBefore="生成数量"
            />
            <Button type="primary" onClick={handleGenerateInviteCodes}>
              生成
            </Button>
          </div>

          {inviteCodes.length > 0 && (
            <div className="space-y-2">
              {inviteCodes.map((code) => (
                <div key={code} className="flex items-center justify-between p-3 bg-white/5 rounded-lg">
                  <code className="text-sm font-mono text-cyan-400">{code}</code>
                  <Button size="small" icon={<CopyOutlined />} onClick={() => copyToClipboard(code)}>
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
