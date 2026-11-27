export const navigation = {
  Accounts: '上游账号', Keys: 'API 密钥', Models: '模型', Requests: '请求记录', Media: '媒体资源',
} as const;

export const labels: Record<string, string> = {
  jimeng: '即梦', codex: 'Codex', kiro: 'Kiro', claude: 'Claude', Default: '默认',
  cookie: 'Cookie', oauth: 'OAuth 授权', 'api-key': 'API 密钥',
  desktop: '桌面账号授权', oidc: 'IAM Identity Center 授权',
  responses: '文本响应', messages: '消息', count_tokens: 'Token 计数', image: '图片', video: '视频',
  queued: '排队中', submitting: '提交中', submission_unknown: '等待确认',
  in_progress: '生成中', running: '执行中', completed: '已完成', succeeded: '成功',
  failed: '失败', interrupted: '已中断',
};

export function cellText(field: string, value: unknown) {
  if (value == null) return '—';
  if (field === 'enabled') return value ? '已启用' : '已停用';
  if (field.endsWith('_at') && typeof value === 'string') return new Date(value).toLocaleString('zh-CN');
  if (['provider', 'kind', 'operation', 'status'].includes(field)) return labels[String(value)] ?? String(value);
  return String(value);
}

export const columns = {
  Accounts: [
    ['label', '账号'],
    ['provider', '供应商'],
    ['kind', '授权方式'],
    ['concurrency', '并发数'],
    ['enabled', '状态'],
  ],
  Keys: [
    ['label', '密钥'],
    ['prefix', '前缀'],
    ['created_at', '创建时间'],
    ['revoked_at', '撤销时间'],
  ],
  Models: [
    ['id', '模型'],
    ['operation', '操作'],
  ],
  Requests: [
    ['model', '模型'],
    ['operation', '操作'],
    ['status', '状态'],
    ['created_at', '开始时间'],
  ],
  Media: [
    ['id', '资源 ID'],
    ['mime', '格式'],
    ['bytes', '字节数'],
    ['created_at', '创建时间'],
  ],
};

export const errorMessages: Record<string, string> = {
  invalid_credentials: '用户名或密码错误',
  admin_required: '请重新登录',
  invalid_origin: '登录地址与控制台配置不一致',
  account_validation_failed: '账号验证失败，请检查凭证',
  no_provider_models: '该账号没有可用模型',
  invalid_pool: '请选择可用的账号池',
  invalid_key: '请输入密钥名称并选择账号池',
  invalid_oauth_callback: '回调地址无效',
  oauth_flow_expired: '授权已过期，请重新发起',
};
