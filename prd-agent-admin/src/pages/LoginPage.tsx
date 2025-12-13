import { useState } from 'react';
import { Form, Input, Button, Message } from '@arco-design/web-react';
import { IconUser, IconLock } from '@arco-design/web-react/icon';
import { useAuthStore } from '../stores/authStore';
import { login } from '../services/api';

const FormItem = Form.Item;

export default function LoginPage() {
  const { login: setAuth } = useAuthStore();
  const [loading, setLoading] = useState(false);
  const [form] = Form.useForm();

  const handleSubmit = async (values: { username: string; password: string }) => {
    setLoading(true);
    try {
      const response = await login(values.username, values.password) as any;
      
      if (response.success && response.data) {
        const { user, accessToken } = response.data;
        
        if (user.role !== 'ADMIN') {
          Message.error('只有管理员可以登录此系统');
          return;
        }
        
        setAuth(user, accessToken);
        Message.success('登录成功');
      } else {
        Message.error(response.error?.message || '登录失败');
      }
    } catch (error: any) {
      Message.error(error.error?.message || '登录失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div 
      className="h-full w-full flex items-center justify-center"
      style={{
        background: 'linear-gradient(135deg, var(--bg-base) 0%, #0f0f12 50%, var(--bg-elevated) 100%)',
      }}
    >
      {/* 背景装饰 */}
      <div 
        style={{
          position: 'absolute',
          width: '600px',
          height: '600px',
          background: 'radial-gradient(circle, rgba(99, 102, 241, 0.08) 0%, transparent 70%)',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'none',
        }}
      />

      {/* 登录卡片 */}
      <div 
        className="animate-fadeInScale"
        style={{
          width: 400,
          padding: 'var(--space-8)',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-xl)',
          boxShadow: 'var(--shadow-xl)',
          position: 'relative',
          zIndex: 1,
        }}
      >
        {/* Logo */}
        <div className="text-center mb-8">
          <div 
            className="mx-auto mb-4 flex items-center justify-center"
            style={{
              width: 56,
              height: 56,
              background: 'var(--accent)',
              borderRadius: 'var(--radius-lg)',
              boxShadow: 'var(--shadow-glow)',
            }}
          >
            <span style={{ color: '#fff', fontWeight: 700, fontSize: 20 }}>P</span>
          </div>
          <h1 
            style={{ 
              fontSize: 24, 
              fontWeight: 600, 
              color: 'var(--text-primary)',
              marginBottom: 4,
              letterSpacing: '-0.02em',
            }}
          >
            PRD Agent
          </h1>
          <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>
            管理后台
          </p>
        </div>

        {/* 表单 */}
        <Form
          form={form}
          layout="vertical"
          onSubmit={handleSubmit}
          autoComplete="off"
        >
          <FormItem
            field="username"
            rules={[{ required: true, message: '请输入用户名' }]}
          >
            <Input
              prefix={<IconUser style={{ color: 'var(--text-muted)' }} />}
              placeholder="用户名"
              size="large"
              style={{ 
                height: 44,
                borderRadius: 'var(--radius-md)',
              }}
            />
          </FormItem>

          <FormItem
            field="password"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password
              prefix={<IconLock style={{ color: 'var(--text-muted)' }} />}
              placeholder="密码"
              size="large"
              style={{ 
                height: 44,
                borderRadius: 'var(--radius-md)',
              }}
            />
          </FormItem>

          <FormItem style={{ marginBottom: 0, marginTop: 'var(--space-6)' }}>
            <Button
              type="primary"
              htmlType="submit"
              long
              loading={loading}
              style={{
                height: 44,
                borderRadius: 'var(--radius-md)',
                fontWeight: 500,
                fontSize: 15,
              }}
            >
              登录
            </Button>
          </FormItem>
        </Form>

        {/* 底部信息 */}
        <div 
          className="text-center mt-6"
          style={{ color: 'var(--text-muted)', fontSize: 12 }}
        >
          PRD Agent Admin v1.0
        </div>
      </div>
    </div>
  );
}
