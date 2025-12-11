import { useState } from 'react';
import { Form, Input, Button, Card, message } from 'antd';
import { UserOutlined, LockOutlined } from '@ant-design/icons';
import { useAuthStore } from '../stores/authStore';
import { login } from '../services/api';

export default function LoginPage() {
  const { login: setAuth } = useAuthStore();
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (values: { username: string; password: string }) => {
    setLoading(true);
    try {
      const response = await login(values.username, values.password) as any;
      
      if (response.success && response.data) {
        const { user, accessToken } = response.data;
        
        if (user.role !== 'ADMIN') {
          message.error('只有管理员可以登录此系统');
          return;
        }
        
        setAuth(user, accessToken);
        message.success('登录成功');
      } else {
        message.error(response.error?.message || '登录失败');
      }
    } catch (error: any) {
      message.error(error.error?.message || '登录失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-screen flex items-center justify-center animated-bg">
      <Card className="w-96" bordered={false}>
        <div className="text-center mb-8">
          <div 
            className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4"
            style={{ background: 'linear-gradient(135deg, #06b6d4, #8b5cf6)' }}
          >
            <span className="text-white font-bold text-2xl">P</span>
          </div>
          <h1 className="text-2xl font-bold text-white">PRD Agent</h1>
          <p className="text-gray-400 text-sm mt-1">管理后台</p>
        </div>

        <Form onFinish={handleSubmit} layout="vertical" size="large">
          <Form.Item
            name="username"
            rules={[{ required: true, message: '请输入用户名' }]}
          >
            <Input
              prefix={<UserOutlined />}
              placeholder="用户名"
            />
          </Form.Item>

          <Form.Item
            name="password"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password
              prefix={<LockOutlined />}
              placeholder="密码"
            />
          </Form.Item>

          <Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              block
              loading={loading}
            >
              登录
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
}
