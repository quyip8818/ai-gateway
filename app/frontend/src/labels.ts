export const navigation = {
  Accounts: '上游账号', Keys: 'API 密钥', Models: '模型', Requests: '请求记录', Media: '媒体资源',
} as const;

export const labels: Record<string, string> = {
  jimeng: '即梦', codex: 'Codex', kiro: 'Kiro', claude: 'Claude',
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
  if (field === 'providers' && Array.isArray(value)) {
    return value.map((item) => labels[item] ?? item).join('、');
  }
  if (field.endsWith('_at') && typeof value === 'string') return new Date(value).toLocaleString('zh-CN');
  if (['kind', 'operation', 'status'].includes(field)) return labels[String(value)] ?? String(value);
  return String(value);
}

export const columns = {
  Accounts: [
    ['label', '账号'],
    ['kind', '授权方式'],
    ['enabled', '状态'],
  ],
  Keys: [
    ['label', '密钥'],
    ['prefix', '前缀'],
    ['providers', '可调用的产品'],
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
  jimeng_invalid_cookie_format: '无法从输入中读取 sessionid。请粘贴完整 Cookie 或 sessionid。',
  jimeng_session_rejected: '即梦拒绝了这个登录会话。请重新登录即梦后复制 sessionid。',
  jimeng_validation_denied: '即梦拒绝了网关发出的验证请求。',
  jimeng_validation_rate_limited: '即梦验证请求过于频繁，请稍后再试。',
  jimeng_validation_unavailable: '网关未能完成即梦上游验证，请稍后重试。',
  jimeng_identity_unconfirmed: '即梦没有返回可确认的账号身份。',
  no_provider_models: '该账号没有可用模型',
  invalid_provider: '请选择支持的产品',
  invalid_key: '请输入密钥名称并选择可调用的产品',
  account_credential_import_in_progress: '该凭证正在添加，请稍后刷新账号列表。',
  duplicate_account_credential: '该凭证已添加，请使用现有账号。',
  invalid_account: '请检查账号信息，名称最多 100 个字符',
  invalid_oauth_callback: '回调地址无效',
  oauth_flow_expired: '授权已过期，请重新发起',
};
