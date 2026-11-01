/**
 * 插件运行期设置。
 *
 * dsh「插件」页保存配置时只提交新值并唤醒 volatile 引用，条目不会重挂，
 * 因此所有读取都必须经过 setSettingsReader 注入的读取器，而不能在
 * apply() 里把值捕获成常量。
 */

/** 未配置时的默认值（与 config.js 的 Schema default 保持一致）。 */
export const DEFAULTS = Object.freeze({
  mcpUrl: 'https://mcp.undermind.ai/mcp',
  /** CIMD（HTTPS URL）或向 Undermind 预注册的 client id；为空时无法发起授权。 */
  clientId: '',
  scope: 'mcp',
  /**
   * 回调地址。CIMD 文档里的 redirect_uris 必须提前声明该值，
   * 因此它是配置项而不是按 dsh web 端口动态生成。
   */
  redirectUri: 'http://127.0.0.1:8799/callback',
  authorizeEndpoint: 'https://api.undermind.ai/o/authorize/',
  tokenEndpoint: 'https://api.undermind.ai/o/token/',
  revocationEndpoint: 'https://api.undermind.ai/o/revoke_token/',
  /** 空字符串表示使用 $DSH_HOME/storages/undermind-mcp-auth.json。 */
  tokenFile: '',
  requestTimeoutMs: 30_000,
  toolTimeoutMs: 180_000,
  /** 等待用户在浏览器完成授权的最长时间。 */
  loginTimeoutMs: 600_000,
  /** 已注册 MCP 工具名要加的前缀。 */
  toolPrefix: 'mcp__undermind__',
  /** 被关掉的 MCP 工具原始名。 */
  disabledTools: [],
});

const NUMERIC_KEYS = new Set(['requestTimeoutMs', 'toolTimeoutMs', 'loginTimeoutMs']);

let reader = () => ({ ...DEFAULTS });

/** 由插件入口注入 volatile 读取器。 */
export function setSettingsReader(fn) {
  reader = typeof fn === 'function' ? fn : () => ({ ...DEFAULTS });
}

/** 取当前设置（已合并默认值并做基本类型收敛）。 */
export function getSettings() {
  let raw;
  try {
    raw = reader() ?? {};
  } catch {
    raw = {};
  }
  const merged = { ...DEFAULTS };
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) continue;
    if (NUMERIC_KEYS.has(key)) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) merged[key] = parsed;
      continue;
    }
    if (key === 'disabledTools') {
      merged[key] = Array.isArray(value) ? value.map((item) => String(item)) : [];
      continue;
    }
    merged[key] = typeof value === 'string' ? value.trim() : value;
  }
  return merged;
}
