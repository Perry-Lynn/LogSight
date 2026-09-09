/*
 * 服务器连接配置对话框
 * 精简布局：仅展示必填项，其余可选配置折叠在“其他”中
 * @Author: fu
 * @LastEditors: fu
 * @Date: 2026-08-27
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  Modal,
  Form,
  Input,
  InputNumber,
  Select,
  Switch,
  Button,
  Upload,
  message,
  App as AntApp,
  Table,
  Popconfirm,
  Tag,
} from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  UploadOutlined,
  EyeInvisibleOutlined,
  EyeTwoTone,
  DownOutlined,
  FileOutlined,
  CheckCircleOutlined,
} from '@ant-design/icons';
import type { UploadFile } from 'antd';
import type { ServerConfig, AuthType, RunScript, LogbackServerConfig } from '@/types';
import {
  getServer,
  saveServer,
  testConnection,
  decryptSecret,
  importLogbackConfig,
  getLogbackConfig,
  deleteLogbackConfig,
} from '@/services/tauriApi';
import { useAppStore } from '@/store/useAppStore';

interface Props {
  visible: boolean;
  editingId?: string | null;
  onCancel: () => void;
  onSaved: (server: ServerConfig) => void;
}

type FormValues = {
  bookmark_category: string[];
  title: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  private_key_pem?: string;
  private_key_path?: string;
  ssh_config_path?: string;
  use_ssh_agent: boolean;
  ssh_agent_path?: string;
  use_mfa: boolean;
  run_scripts_enabled: boolean;
  run_scripts: RunScript[];
  description: string;
  auth_type: AuthType;
};

/**
 * 服务器连接配置对话框组件类
 * 新增/编辑服务器连接的紧凑表单，必填项外露、可选项折叠
 */
const ServerConnectionDialog: React.FC<Props> = ({
  visible,
  editingId,
  onCancel,
  onSaved,
}) => {
  const { message: msg } = AntApp.useApp();
  const [form] = Form.useForm<FormValues>();
  const masterPassword = useAppStore((s) => s.masterPassword);
  const setSecret = useAppStore((s) => s.setSecret);
  const servers = useAppStore((s) => s.servers);

  const [submitting, setSubmitting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [activeTab, setActiveTab] = useState<'connection' | 'advanced' | 'logback'>('connection');

  const [logbackConfig, setLogbackConfig] = useState<LogbackServerConfig | null>(null);
  const [logbackLoading, setLogbackLoading] = useState(false);
  const [logbackUploading, setLogbackUploading] = useState(false);

  // 实时监听认证方式切换，确保 Tab 按钮 active 状态即时响应
  const authType = (Form.useWatch('auth_type', form) as AuthType) || 'Password';

  const editingServer = useMemo<ServerConfig | undefined>(
    () => servers.find((s) => s.id === editingId),
    [editingId, servers],
  );

  /* 弹窗打开时：初始化表单默认值；编辑模式时解密明文填充密码/私钥 */
  useEffect(() => {
    if (!visible) return;
    const defaults: FormValues = {
      bookmark_category: ['default'],
      title: '',
      host: '',
      port: 22,
      username: '',
      password: '',
      private_key_pem: '',
      private_key_path: '',
      ssh_config_path: '~/.ssh/config',
      use_ssh_agent: false,
      ssh_agent_path: '',
      use_mfa: false,
      run_scripts_enabled: false,
      run_scripts: [],
      description: '',
      auth_type: 'Password',
    };
    if (editingServer) {
      // 编辑模式：从解密缓存加载；若缓存无则异步解密 cipher
      const fill: FormValues = {
        ...defaults,
        bookmark_category: (editingServer.bookmark_category || 'default').split(',').filter(Boolean),
        title: editingServer.title,
        host: editingServer.host,
        port: editingServer.port,
        username: editingServer.username,
        auth_type: editingServer.auth_type,
        private_key_path: editingServer.private_key_path || '',
        ssh_config_path: editingServer.ssh_config_path || '~/.ssh/config',
        use_ssh_agent: !!editingServer.use_ssh_agent,
        ssh_agent_path: editingServer.ssh_agent_path || '',
        use_mfa: !!editingServer.use_mfa,
        run_scripts_enabled: !!editingServer.run_scripts_enabled,
        run_scripts: editingServer.run_scripts?.length
          ? editingServer.run_scripts
          : [{ content: '', delay_ms: 500 }],
        description: editingServer.description || '',
      };
      form.setFieldsValue(fill);
      // 异步解密密码/私钥明文到表单（同时写缓存）
      if (masterPassword) {
        (async () => {
          if (editingServer.password_cipher) {
            try {
              const pwd = await decryptSecret(
                editingServer.password_cipher,
                masterPassword,
              );
              form.setFieldsValue({ password: pwd });
              setSecret(editingServer.id, pwd);
            } catch (_) {
              /* ignore */
            }
          }
          if (editingServer.private_key_cipher) {
            try {
              const pem = await decryptSecret(
                editingServer.private_key_cipher,
                masterPassword,
              );
              form.setFieldsValue({ private_key_pem: pem });
              setSecret(editingServer.id, undefined, pem);
            } catch (_) {
              /* ignore */
            }
          }
        })();
      }
    } else {
      // 新增：给一个默认脚本槽位占位，其他全空
      defaults.run_scripts = [{ content: '', delay_ms: 500 }];
      form.setFieldsValue(defaults);
    }
    setFileList([]);
    setActiveTab('connection');
    setLogbackConfig(null);
  }, [visible, editingId, form, masterPassword, editingServer, setSecret]);

  useEffect(() => {
    if (!visible || !editingId) {
      setLogbackConfig(null);
      return;
    }
    setLogbackLoading(true);
    getLogbackConfig(editingId)
      .then((cfg) => setLogbackConfig(cfg))
      .catch(() => setLogbackConfig(null))
      .finally(() => setLogbackLoading(false));
  }, [visible, editingId]);

  /** 组装当前表单值 + 明文密码/私钥，调用 save_server IPC */
  const handleSubmit = async () => {
    if (!masterPassword) {
      msg.error('应用主密码尚未初始化，请重启应用');
      return;
    }
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const password_plain =
        values.auth_type === 'Password' ? values.password ?? null : null;
      const private_key_pem_plain =
        values.auth_type === 'PrivateKey' ? values.private_key_pem ?? null : null;

      const rawCategory = values.bookmark_category;
      const bookmark_category = Array.isArray(rawCategory)
        ? rawCategory.join(',')
        : (rawCategory || 'default');

      const payload = {
        id: editingServer?.id ?? '',
        bookmark_category,
        title: values.title,
        host: values.host,
        port: values.port ?? 22,
        username: values.username,
        auth_type: values.auth_type,
        private_key_path: values.private_key_path || null,
        ssh_config_path: values.ssh_config_path || null,
        use_ssh_agent: !!values.use_ssh_agent,
        ssh_agent_path: values.ssh_agent_path || null,
        use_mfa: !!values.use_mfa,
        run_scripts_enabled: !!values.run_scripts_enabled,
        run_scripts: (values.run_scripts || []).filter((s) => s.content?.trim()),
        description: values.description || '',
      };
      const saved = await saveServer(
        payload as ServerConfig,
        password_plain,
        private_key_pem_plain,
        masterPassword,
      );
      if (password_plain) setSecret(saved.id, password_plain);
      if (private_key_pem_plain) setSecret(saved.id, undefined, private_key_pem_plain);
      msg.success(editingServer ? '服务器配置已更新' : '服务器配置已保存');
      onSaved(saved);
    } catch (e: any) {
      if (e?.errorFields) {
        msg.error('请检查表单必填项是否完整');
      } else {
        msg.error(e?.message || '保存失败，请重试');
      }
    } finally {
      setSubmitting(false);
    }
  };

  /** 测试连接（一次性连接） */
  const handleTestConnection = async () => {
    if (!masterPassword) return msg.error('主密码未初始化，请重启应用或稍候 1 秒后再试');
    try {
      const values = await form.validateFields();
      setTesting(true);

      // 密码/私钥兜底：表单没填但编辑模式有密文 → 立刻临时解密一次
      let pwd_plain: string | null = values.auth_type === 'Password' ? values.password ?? null : null;
      let pem_plain: string | null = values.auth_type === 'PrivateKey' ? values.private_key_pem ?? null : null;

      if (values.auth_type === 'Password' && (!pwd_plain || !pwd_plain.trim()) && editingServer?.password_cipher && masterPassword) {
        try {
          const decrypted = await decryptSecret(editingServer.password_cipher, masterPassword);
          if (decrypted) {
            pwd_plain = decrypted;
            form.setFieldsValue({ password: decrypted });
            setSecret(editingServer.id, decrypted);
            msg.info('已自动从已保存配置中解密密码用于测试连接（密码框已自动填充）');
          }
        } catch {
          // 解密失败忽略，继续让用户手动填
        }
      }
      if (values.auth_type === 'PrivateKey' && (!pem_plain || !pem_plain.trim()) && editingServer?.private_key_cipher && masterPassword) {
        try {
          const decrypted = await decryptSecret(editingServer.private_key_cipher, masterPassword);
          if (decrypted) {
            pem_plain = decrypted;
            form.setFieldsValue({ private_key_pem: decrypted });
            setSecret(editingServer.id, undefined, decrypted);
            msg.info('已自动从已保存配置中解密私钥用于测试连接（私钥 PEM 已自动填充）');
          }
        } catch {
          // ignore
        }
      }
      // 最终再次兜底：密码模式必须有非空 pwd_plain
      if (values.auth_type === 'Password' && (!pwd_plain || !pwd_plain.trim())) {
        msg.error('密码为空：请在编辑框输入密码，或保存后再测试连接');
        setTesting(false);
        return;
      }
      if (values.auth_type === 'PrivateKey' && (!pem_plain || !pem_plain.trim()) && !values.private_key_path) {
        msg.error('私钥为空：请粘贴 PEM 内容或选择私钥文件');
        setTesting(false);
        return;
      }

      const snapshot: ServerConfig = {
        id: 'test',
        bookmark_category: Array.isArray(values.bookmark_category)
          ? values.bookmark_category.join(',')
          : (values.bookmark_category || 'default'),
        title: values.title,
        host: values.host,
        port: values.port,
        username: values.username,
        auth_type: values.auth_type,
        password_cipher: null,
        private_key_cipher: null,
        private_key_path: values.private_key_path || null,
        ssh_config_path: values.ssh_config_path || null,
        use_ssh_agent: !!values.use_ssh_agent,
        ssh_agent_path: values.ssh_agent_path || null,
        use_mfa: !!values.use_mfa,
        run_scripts_enabled: !!values.run_scripts_enabled,
        run_scripts: (values.run_scripts || []).filter((s) => s.content?.trim()) || [],
        description: values.description || '',
        created_at: new Date(0).toISOString(),
        updated_at: new Date(0).toISOString(),
        last_connected_at: null,
      };
      const res = await testConnection(snapshot, pwd_plain, pem_plain);
      if (res.success) {
        msg.success(`连接成功！延迟 ${res.latency_ms} ms` + (res.banner ? ` · Banner: ${res.banner.slice(0, 60)}` : ''));
        if (res.remote_environment && !res.remote_environment.supported) {
          msg.warning(res.remote_environment.message || 'SSH 已连接，但当前远程环境不满足日志命令要求');
        }
      } else {
        msg.error(`连接失败：${res.error_message ?? '未知错误'}`);
      }
    } catch (e: any) {
      msg.error(e?.message || '测试失败');
    } finally {
      setTesting(false);
    }
  };

  /** 私钥文件上传：直接读取本地文件内容填入 private_key_pem */
  const handlePrivateKeyUpload = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const content = (reader.result as string).toString();
      form.setFieldsValue({ private_key_pem: content });
      msg.success('私钥文件已读取，请确认内容完整');
    };
    reader.readAsText(file);
    return false; // 阻止自动上传到服务器
  };

  /** 新增一个运行脚本行 */
  const addRunScript = () => {
    const list = form.getFieldValue('run_scripts') as RunScript[] || [];
    form.setFieldsValue({
      run_scripts: [...list, { content: '', delay_ms: 500 }],
    });
  };

  /** 删除指定索引的运行脚本行 */
  const removeRunScript = (index: number) => {
    const list = [...(form.getFieldValue('run_scripts') as RunScript[] || [])];
    list.splice(index, 1);
    form.setFieldsValue({ run_scripts: list });
  };

  /** 上传 logback.xml 文件并导入配置 */
  const handleLogbackUpload = (file: File) => {
    if (!editingId) {
      msg.warning('请先保存服务器后再导入 logback 配置');
      return false;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      const xmlContent = reader.result as string;
      setLogbackUploading(true);
      try {
        const cfg = await importLogbackConfig(editingId, xmlContent);
        setLogbackConfig(cfg);
        msg.success(`已导入 ${cfg.appenders.length} 个 appender 配置`);
      } catch (e: any) {
        msg.error(e?.message || 'logback.xml 解析失败');
      } finally {
        setLogbackUploading(false);
      }
    };
    reader.readAsText(file);
    return false;
  };

  /** 删除当前服务器的 logback 配置 */
  const handleLogbackDelete = async () => {
    if (!editingId) return;
    try {
      await deleteLogbackConfig(editingId);
      setLogbackConfig(null);
      msg.success('已删除 logback 配置');
    } catch (e: any) {
      msg.error(e?.message || '删除失败');
    }
  };

  /* ========= 渲染 ========= */

  const renderAuthPanel = () => {
    return (
      <Form.Item noStyle shouldUpdate={(p, n) => p.auth_type !== n.auth_type}>
        {({ getFieldValue }) => {
          const t: AuthType = getFieldValue('auth_type');
          if (t === 'Password') {
            return (
              <Form.Item label="密码" name="password" rules={[{ required: true, message: '请输入密码' }]} className="!mb-3">
                <Input.Password
                  placeholder="输入 SSH 登录密码"
                  iconRender={(v) => (v ? <EyeTwoTone /> : <EyeInvisibleOutlined />)}
                  visibilityToggle
                />
              </Form.Item>
            );
          }
          if (t === 'PrivateKey') {
            return (
              <>
                <div className="flex items-center gap-3 mb-2">
                  <Upload
                    fileList={fileList}
                    onChange={({ fileList: list }) => setFileList(list.slice(-1))}
                    beforeUpload={handlePrivateKeyUpload}
                    accept=".pem,.key,.pub"
                    maxCount={1}
                  >
                    <Button icon={<UploadOutlined />} size="small" className="rounded-lg">选择私钥文件</Button>
                  </Upload>
                  <span className="text-xs" style={{ color: 'var(--ls-text-tertiary)' }}>或粘贴 PEM 内容</span>
                </div>
                <Form.Item label="私钥 PEM" name="private_key_pem" rules={[{ required: true, message: '请填写私钥内容或上传文件' }]} className="!mb-3">
                  <Input.TextArea rows={3} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;..." />
                </Form.Item>
                <Form.Item label="私钥路径（备选）" name="private_key_path" className="!mb-3">
                  <Input placeholder="如 ~/.ssh/id_rsa（留空则使用上方 PEM 内容）" />
                </Form.Item>
              </>
            );
          }
          return (
            <Form.Item label="配置文件路径" name="ssh_config_path" className="!mb-3">
              <Input placeholder="~/.ssh/config（将自动按 Host 别名匹配）" />
            </Form.Item>
          );
        }}
      </Form.Item>
    );
  };

  const renderRunScripts = () => (
    <Form.List name="run_scripts">
      {(fields, { add, remove }, { errors }) => (
        <div
          className="rounded-lg p-3 space-y-2"
          style={{
            backgroundColor: 'var(--ls-bg-overlay)',
            border: '1px solid var(--ls-border-l1)',
          }}
        >
          {fields.map(({ key, name, ...restField }, idx) => (
            <div key={key} className="flex gap-2 items-start">
              <Form.Item
                {...restField}
                name={[name, 'delay_ms']}
                className="!mb-0 !w-[170px]"
              >
                <InputNumber
                  addonBefore="延迟"
                  addonAfter="ms"
                  min={0}
                  max={60000}
                  controls={false}
                  style={{ width: '100%' }}
                />
              </Form.Item>
              <Form.Item
                {...restField}
                name={[name, 'content']}
                className="!mb-0 flex-1"
              >
                <Input placeholder="Shell 脚本内容" />
              </Form.Item>
              <Button
                type="text"
                danger
                icon={<DeleteOutlined />}
                onClick={() => {
                  remove(name);
                  removeRunScript(idx);
                }}
                className="mac-titlebar-nd rounded-lg"
              />
            </div>
          ))}
          <Button
            type="dashed"
            block
            icon={<PlusOutlined />}
            onClick={() => {
              add();
              addRunScript();
            }}
            className="mac-titlebar-nd rounded-lg"
            style={{ borderColor: 'var(--ls-border-l2)', color: 'var(--ls-text-secondary)' }}
          >
            添加运行脚本
          </Button>
        </div>
      )}
    </Form.List>
  );

  return (
    <Modal
      open={visible}
      title={editingServer ? '编辑服务器连接' : '新建服务器连接'}
      width={480}
      onCancel={onCancel}
      onOk={handleSubmit}
      confirmLoading={submitting}
      okText={editingServer ? '保存修改' : '保存连接'}
      destroyOnClose
      className="logsight-connection-dialog"
      footer={[
        <Button key="cancel" onClick={onCancel} className="mac-titlebar-nd rounded-lg">
          取消
        </Button>,
        <Button
          key="test"
          loading={testing}
          onClick={handleTestConnection}
          className="mac-titlebar-nd rounded-lg"
        >
          测试连接
        </Button>,
        <Button
          key="ok"
          type="primary"
          loading={submitting}
          onClick={handleSubmit}
          className="mac-titlebar-nd rounded-lg ls-btn-primary-glow"
        >
          {editingServer ? '保存修改' : '保存连接'}
        </Button>,
      ]}
    >
      <Form
        form={form}
        layout="vertical"
        requiredMark
        className="mt-2"
        initialValues={{ auth_type: 'Password', port: 22, use_ssh_agent: false, use_mfa: false }}
      >
        {/* Tab 切换：连接 / 高级 */}
        <div
          className="flex rounded-lg overflow-hidden mb-3"
          style={{
            border: '1px solid var(--ls-border-l1)',
            backgroundColor: 'var(--ls-bg-overlay)',
          }}
        >
          {([
            { key: 'connection' as const, label: '连接' },
            { key: 'advanced' as const, label: '高级' },
            { key: 'logback' as const, label: '日志配置' },
          ]).map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className="flex-1 py-1.5 text-sm font-medium transition-colors duration-150"
              style={{
                backgroundColor: activeTab === tab.key ? 'var(--ls-bg-surface)' : 'transparent',
                color: activeTab === tab.key ? 'var(--ls-text-primary)' : 'var(--ls-text-tertiary)',
                borderBottom: activeTab === tab.key ? '2px solid var(--ls-brand-cyan)' : '2px solid transparent',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div style={{ display: activeTab === 'connection' ? undefined : 'none' }}>
          <Form.Item
            label="标题"
            name="title"
            rules={[{ required: true, message: '请输入连接标题' }]}
            className="!mb-3"
          >
            <Input placeholder="项目名-IP" />
          </Form.Item>

          <Form.Item
            label="主机地址"
            name="host"
            rules={[{ required: true, message: '请输入主机 IP 或域名' }]}
            className="!mb-3"
          >
            <Input placeholder="hostname or ip" />
          </Form.Item>

          <Form.Item
            label="用户名"
            name="username"
            rules={[{ required: true, message: '请输入登录用户名' }]}
            className="!mb-3"
          >
            <Input placeholder="www / root" />
          </Form.Item>

          <Form.Item label="认证方式" name="auth_type" className="!mb-1">
            <div className="auth-tab-pill">
              {(['Password', 'PrivateKey'] as AuthType[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  className={authType === t ? 'active' : ''}
                  onClick={() => form.setFieldsValue({ auth_type: t })}
                >
                  {t === 'Password' ? '密码' : '私钥/证书'}
                </button>
              ))}
            </div>
          </Form.Item>
          {renderAuthPanel()}

          <Form.Item
            label={<span><span className="text-red-500 mr-0.5">*</span> 端口</span>}
            name="port"
            rules={[{ required: true, message: 'SSH 端口必填' }]}
            className="!mb-3"
          >
            <InputNumber min={1} max={65535} style={{ width: 120 }} />
          </Form.Item>
        </div>

        <div style={{ display: activeTab === 'advanced' ? undefined : 'none' }}>
          <div className="space-y-1">
            <Form.Item label="书签分类" name="bookmark_category" className="!mb-2">
              <Select
                allowClear
                mode="tags"
                maxTagCount={3}
                placeholder="选择或创建分类"
                options={[
                  { label: 'default', value: 'default' },
                  { label: '生产环境', value: 'prod' },
                  { label: '测试环境', value: 'test' },
                  { label: '开发环境', value: 'dev' },
                ]}
                style={{ width: '100%' }}
              />
            </Form.Item>

            <div className="text-[11px] mb-2" style={{ color: 'var(--ls-text-tertiary)' }}>
              当前版本支持密码和私钥认证；SSH Agent、配置文件和 MFA/OTP 仍在规划中。
            </div>

            <Form.Item
              label="允许自动执行脚本"
              name="run_scripts_enabled"
              valuePropName="checked"
              className="!mb-2"
              extra="关闭时仅保存脚本，不会在连接后执行。"
            >
              <Switch size="small" />
            </Form.Item>

            <Form.Item label="运行脚本" className="!mb-2">
              {renderRunScripts()}
            </Form.Item>

            <Form.Item label="描述" name="description" className="!mb-0">
              <Input.TextArea rows={2} placeholder="备注描述（可选）" />
            </Form.Item>
          </div>
        </div>

        <div style={{ display: activeTab === 'logback' ? undefined : 'none' }}>
          <div className="space-y-3">
            {!editingId ? (
              <div className="text-center py-6">
                <div className="text-sm mb-2" style={{ color: 'var(--ls-text-secondary)' }}>
                  请先保存服务器配置，再导入 logback.xml
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <Upload
                    accept=".xml"
                    showUploadList={false}
                    beforeUpload={handleLogbackUpload}
                  >
                    <Button
                      icon={<UploadOutlined />}
                      loading={logbackUploading}
                      className="mac-titlebar-nd rounded-lg"
                      size="small"
                    >
                      导入 logback.xml
                    </Button>
                  </Upload>
                  {logbackConfig && (
                    <Popconfirm
                      title="确定删除该 logback 配置？"
                      onConfirm={handleLogbackDelete}
                      okText="删除"
                      cancelText="取消"
                    >
                      <Button
                        danger
                        size="small"
                        icon={<DeleteOutlined />}
                        className="mac-titlebar-nd rounded-lg"
                      >
                        删除配置
                      </Button>
                    </Popconfirm>
                  )}
                  {logbackLoading && (
                    <span className="text-xs" style={{ color: 'var(--ls-text-tertiary)' }}>加载中...</span>
                  )}
                </div>

                {logbackConfig ? (
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <CheckCircleOutlined style={{ color: '#52c41a' }} />
                      <span className="text-xs" style={{ color: 'var(--ls-text-secondary)' }}>
                        已导入 {logbackConfig.appenders.length} 个 appender
                        {logbackConfig.log_base_path && (
                          <span>，日志根目录：<code className="text-[11px]">{logbackConfig.log_base_path}</code></span>
                        )}
                        <span className="ml-2" style={{ color: 'var(--ls-text-tertiary)' }}>
                          导入时间：{new Date(logbackConfig.imported_at).toLocaleString()}
                        </span>
                      </span>
                    </div>
                    <Table
                      size="small"
                      dataSource={logbackConfig.appenders}
                      rowKey="name"
                      pagination={false}
                      className="text-xs"
                      scroll={{ x: 'max-content' }}
                      columns={[
                        {
                          title: '名称',
                          dataIndex: 'label',
                          width: 100,
                          render: (label: string, row) => (
                            <div>
                              <div className="font-medium text-[12px]">{label}</div>
                              <div className="text-[9px]" style={{ color: 'var(--ls-text-tertiary)' }}>{row.name}</div>
                            </div>
                          ),
                        },
                        {
                          title: '分组',
                          dataIndex: 'group',
                          width: 70,
                          render: (g: string) => <Tag className="!text-[9px] px-1 py-0">{g}</Tag>,
                        },
                        {
                          title: '路径 / 滚动模式',
                          key: 'path',
                          ellipsis: true,
                          render: (_: unknown, row) => (
                            <code className="text-[10px] break-all">
                              {row.glob_pattern || row.file_path || '-'}
                            </code>
                          ),
                        },
                        {
                          title: '类型',
                          dataIndex: 'error_only',
                          width: 50,
                          render: (err: boolean) => err
                            ? <Tag color="error" className="!text-[9px] px-1 py-0">ERR</Tag>
                            : <Tag className="!text-[9px] px-1 py-0">ALL</Tag>,
                        },
                      ]}
                    />
                  </div>
                ) : (
                  !logbackLoading && (
                    <div
                      className="text-center py-6 rounded-lg"
                      style={{
                        border: '1px dashed var(--ls-border-l2)',
                        color: 'var(--ls-text-tertiary)',
                      }}
                    >
                      <FileOutlined className="text-2xl mb-2" />
                      <div className="text-xs">
                        尚未导入 logback.xml 配置
                        <br />
                        <span className="text-[10px]">
                          点击上方按钮上传项目的 logback.xml，自动提取日志路径和滚动规则
                        </span>
                      </div>
                    </div>
                  )
                )}
              </>
            )}
          </div>
        </div>
      </Form>
    </Modal>
  );
};

export default ServerConnectionDialog;
