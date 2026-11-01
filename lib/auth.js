/**
 * Undermind OAuth 令牌管理（authorization code + PKCE，无 client secret）。
 *
 * 关键事实（来自 https://www.undermind.ai/mcp 与 api.undermind.ai 的
 * oauth-authorization-server 元数据）：
 * - access token 有效期 1 小时；
 * - refresh token 每次使用后轮换，旧值立即失效，因此刷新后必须马上落盘；
 * - 请求要带 RFC 8707 的 resource 参数（https://mcp.undermind.ai/mcp）；
 * - 客户端认证方式为 `none`（公共客户端，无 secret）。
 */
import { clearTokenState, readTokenState, resolveTokenFile, writeTokenState } from './store.js';

/** 提前这么久就视为过期，避免请求在途中失效。 */
const EXPIRY_SKEW_MS = 90_000;

export class UndermindAuthError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'UndermindAuthError';
    this.code = code;
    this.detail = detail;
  }
}

function formEncode(fields) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  return params;
}

async function readJsonSafe(response) {
  const text = await response.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function describeTokenError(json) {
  if (!json || typeof json !== 'object') return '令牌端点返回了无法解析的响应';
  const error = typeof json.error === 'string' ? json.error : '';
  const description = typeof json.error_description === 'string' ? json.error_description : '';
  if (description) return error ? `${error}: ${description}` : description;
  if (error) return error;
  return JSON.stringify(json).slice(0, 400);
}

export class TokenManager {
  constructor() {
    this.loaded = false;
    this.state = null;
    this.inflightRefresh = null;
  }

  /** 丢弃内存状态，下次访问重新读盘（配置变更 / 退出登录后调用）。 */
  reset() {
    this.loaded = false;
    this.state = null;
    this.inflightRefresh = null;
  }

  async load(settings) {
    if (this.loaded) return this.state;
    const stored = await readTokenState(settings);
    this.loaded = true;
    // 令牌属于某个 client；用户改了 clientId 就当作未授权，避免拿旧令牌打新客户端。
    if (stored && settings.clientId && stored.clientId && stored.clientId !== settings.clientId) {
      this.state = null;
      return null;
    }
    this.state = stored;
    return this.state;
  }

  static isExpired(state, now = Date.now()) {
    if (!state) return true;
    if (!Number.isFinite(state.expiresAt) || state.expiresAt <= 0) return true;
    return state.expiresAt - EXPIRY_SKEW_MS <= now;
  }

  /**
   * 取一个可用 access token。
   * @param {object} settings
   * @param {{forceRefresh?: boolean}} [options]
   */
  async getAccessToken(settings, options = {}) {
    const state = await this.load(settings);
    if (!state) {
      throw new UndermindAuthError(
        'not_authorized',
        '尚未授权 Undermind。请先调用 undermind_auth（action="login"）完成浏览器授权。',
      );
    }
    if (!options.forceRefresh && !TokenManager.isExpired(state)) {
      return state.accessToken;
    }
    if (!state.refreshToken) {
      throw new UndermindAuthError(
        'expired_no_refresh',
        'Undermind 访问令牌已过期且没有 refresh token，请重新授权（undermind_auth，action="login"）。',
      );
    }
    const refreshed = await this.refresh(settings);
    return refreshed.accessToken;
  }

  /** 用 refresh token 换新令牌；并发调用共享同一次请求（防轮换竞态）。 */
  async refresh(settings) {
    if (this.inflightRefresh) return this.inflightRefresh;
    const task = (async () => {
      const state = await this.load(settings);
      if (!state?.refreshToken) {
        throw new UndermindAuthError('not_authorized', '没有可用的 refresh token，请重新授权。');
      }
      const endpoint = settings.tokenEndpoint;
      const body = formEncode({
        grant_type: 'refresh_token',
        refresh_token: state.refreshToken,
        client_id: settings.clientId || state.clientId,
        resource: settings.mcpUrl,
      });
      let response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
          },
          body,
          signal: AbortSignal.timeout(settings.requestTimeoutMs),
        });
      } catch (error) {
        throw new UndermindAuthError('network_error', `刷新令牌时网络失败：${error?.message ?? error}`);
      }
      const json = await readJsonSafe(response);
      if (!response.ok) {
        const detail = describeTokenError(json);
        // 400 invalid_grant 通常意味着 refresh token 已被用过或撤销 —— 只能重新授权。
        await clearTokenState(settings).catch(() => {});
        this.state = null;
        this.loaded = true;
        throw new UndermindAuthError(
          response.status === 400 ? 'refresh_rejected' : 'refresh_failed',
          `刷新 Undermind 令牌失败（HTTP ${response.status}）：${detail}`,
          json,
        );
      }
      return this.acceptTokenResponse(settings, json, { clientId: settings.clientId || state.clientId });
    })();
    this.inflightRefresh = task;
    try {
      return await task;
    } finally {
      if (this.inflightRefresh === task) this.inflightRefresh = null;
    }
  }

  /** 把 token 端点的响应规范化并持久化。 */
  async acceptTokenResponse(settings, json, extra = {}) {
    if (!json || typeof json !== 'object' || typeof json.access_token !== 'string') {
      throw new UndermindAuthError('bad_token_response', `令牌端点响应缺少 access_token：${describeTokenError(json)}`);
    }
    const expiresIn = Number(json.expires_in);
    const now = Date.now();
    const previous = this.state;
    const state = {
      accessToken: json.access_token,
      // 轮换语义：新响应没给 refresh_token 时，保留旧的那个（部分实现如此）。
      refreshToken:
        typeof json.refresh_token === 'string' && json.refresh_token.length > 0
          ? json.refresh_token
          : (previous?.refreshToken ?? ''),
      tokenType: typeof json.token_type === 'string' ? json.token_type : 'Bearer',
      scope: typeof json.scope === 'string' ? json.scope : (previous?.scope ?? settings.scope),
      expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : now + 3_600_000,
      clientId: extra.clientId ?? settings.clientId ?? previous?.clientId ?? '',
      resource: settings.mcpUrl,
      tokenEndpoint: settings.tokenEndpoint,
      obtainedAt: new Date(now).toISOString(),
    };
    this.state = state;
    this.loaded = true;
    await writeTokenState(settings, state);
    return state;
  }

  async signOut(settings) {
    const state = await this.load(settings);
    const token = state?.refreshToken || state?.accessToken;
    this.reset();
    let revoked = false;
    if (token && settings.revocationEndpoint) {
      // 撤销失败不影响本地退出（网络问题时仍要能登出）。
      try {
        const response = await fetch(settings.revocationEndpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
          },
          body: formEncode({ token, token_type_hint: state?.refreshToken ? 'refresh_token' : 'access_token', client_id: settings.clientId }),
          signal: AbortSignal.timeout(Math.min(settings.requestTimeoutMs, 10_000)),
        });
        revoked = response.ok;
      } catch {
        revoked = false;
      }
    }
    await clearTokenState(settings).catch(() => {});
    return { revoked, tokenFile: resolveTokenFile(settings) };
  }

  async status(settings) {
    const state = await this.load(settings);
    if (!state) {
      return {
        authorized: false,
        expired: false,
        expiresAt: 0,
        expiresInSeconds: 0,
        scope: '',
        clientId: settings.clientId,
        refreshable: false,
        tokenFile: resolveTokenFile(settings),
      };
    }
    const expired = TokenManager.isExpired(state);
    return {
      authorized: true,
      expired,
      expiresAt: state.expiresAt,
      expiresInSeconds: Math.max(0, Math.round((state.expiresAt - Date.now()) / 1000)),
      scope: state.scope,
      clientId: state.clientId || settings.clientId,
      refreshable: Boolean(state.refreshToken),
      obtainedAt: state.obtainedAt,
      tokenFile: resolveTokenFile(settings),
    };
  }
}

/** 插件内共享的单例（进程内只有一份令牌视图）。 */
export const tokenManager = new TokenManager();
