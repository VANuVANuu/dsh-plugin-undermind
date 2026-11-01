/**
 * Undermind OAuth 授权码流程（PKCE S256，公共客户端）。
 *
 * 授权端点 / 令牌端点来自 https://www.undermind.ai/mcp 与
 * api.undermind.ai 的 oauth-authorization-server 元数据：
 *   authorization_endpoint   https://api.undermind.ai/o/authorize/
 *   token_endpoint           https://api.undermind.ai/o/token/
 *   revocation_endpoint      https://api.undermind.ai/o/revoke_token/
 *   code_challenge_methods   ["S256"]
 *   scopes_supported         ["mcp"]
 *   resource_indicators      true
 *
 * Undermind 不支持 Dynamic Client Registration：client_id 必须是
 * (a) 一个 HTTPS 的 Client ID Metadata Document URL，或 (b) 向其团队预注册的
 * client id。因此插件把 clientId 交给用户配置，自己只负责把流程跑通。
 */
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

export class UndermindAuthError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'UndermindAuthError';
    this.code = code;
    this.detail = detail;
  }
}

function base64Url(buffer) {
  return buffer.toString('base64').replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

export function createPkcePair() {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier, 'ascii').digest());
  return { verifier, challenge };
}

export function buildAuthorizeUrl(settings, { state, challenge }) {
  if (!settings.clientId) {
    throw new UndermindAuthError(
      'missing_client_id',
      '未配置 clientId。Undermind 不支持动态客户端注册，需要一个 Client ID Metadata Document URL 或预注册 client id；请在 dsh 插件设置里填写 clientId 后重试。',
    );
  }
  const url = new URL(settings.authorizeEndpoint);
  const params = url.searchParams;
  params.set('response_type', 'code');
  params.set('client_id', settings.clientId);
  params.set('redirect_uri', settings.redirectUri);
  params.set('scope', settings.scope || 'mcp');
  params.set('state', state);
  params.set('code_challenge', challenge);
  params.set('code_challenge_method', 'S256');
  // RFC 8707 resource indicator：令牌绑定到 MCP 端点本身。
  params.set('resource', settings.mcpUrl);
  return url.toString();
}

async function readJsonSafe(response) {
  const text = await response.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 800) };
  }
}

function describeError(json) {
  if (!json || typeof json !== 'object') return '无法解析的响应';
  const error = typeof json.error === 'string' ? json.error : '';
  const description = typeof json.error_description === 'string' ? json.error_description : '';
  if (description) return error ? `${error}: ${description}` : description;
  return error || JSON.stringify(json).slice(0, 400);
}

/** 用授权码换令牌（带 PKCE verifier 与 resource）。 */
export async function exchangeCode(settings, { code, verifier }) {
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', code);
  body.set('redirect_uri', settings.redirectUri);
  body.set('client_id', settings.clientId);
  body.set('code_verifier', verifier);
  body.set('resource', settings.mcpUrl);

  let response;
  try {
    response = await fetch(settings.tokenEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body,
      signal: AbortSignal.timeout(settings.requestTimeoutMs),
    });
  } catch (error) {
    throw new UndermindAuthError('network_error', `换取令牌时网络失败：${error?.message ?? error}`);
  }
  const json = await readJsonSafe(response);
  if (!response.ok) {
    throw new UndermindAuthError(
      'token_exchange_failed',
      `换取 Undermind 令牌失败（HTTP ${response.status}）：${describeError(json)}`,
      json,
    );
  }
  return json;
}

function callbackPathOf(redirectUri) {
  try {
    const url = new URL(redirectUri);
    return url.pathname || '/callback';
  } catch {
    return '/callback';
  }
}

function listenAddressOf(redirectUri) {
  const url = new URL(redirectUri);
  const host = url.hostname === 'localhost' ? '127.0.0.1' : url.hostname.replace(/^\[|\]$/gu, '');
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  return { host, port };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, (char) => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

function renderPage(title, message, tone) {
  const color = tone === 'error' ? '#b42318' : '#0f5132';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark}
body{font:15px/1.6 -apple-system,"Segoe UI",system-ui,sans-serif;margin:0;min-height:100vh;
display:grid;place-items:center;background:#f6f7f9;color:#1f2328}
.card{max-width:520px;padding:32px 36px;background:#fff;border-radius:14px;
box-shadow:0 12px 40px rgba(15,23,42,.12)}
h1{font-size:19px;margin:0 0 10px;color:${color}}
p{margin:0;color:#4b5563;white-space:pre-wrap}
@media (prefers-color-scheme:dark){body{background:#16181d;color:#e6e8eb}
.card{background:#1f2228;box-shadow:none}h1{color:${tone === 'error' ? '#ff8b7b' : '#79d99a'}}
p{color:#a8aeb8}}
</style></head><body><div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div></body></html>`;
}

/**
 * 一次登录尝试：先占住回调端口，再给出授权 URL。
 *
 * 端口必须先监听成功：否则用户授权完发现回调无人应答，会白白消耗一次性 code。
 */
export class LoginFlow {
  constructor(settings) {
    this.settings = settings;
    this.server = null;
    this.state = base64Url(randomBytes(24));
    this.pkce = createPkcePair();
    this.result = null;
    this.settled = null;
    this.settle = null;
    this.settled = new Promise((resolve) => {
      this.settle = resolve;
    });
    this.closed = false;
  }

  /** 监听回调端口；前一次登录刚关掉时端口可能还没释放，故对 EADDRINUSE 短暂重试。 */
  async listenWithRetry(host, port, attempts = 4) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await new Promise((resolve, reject) => {
          const onError = (error) => {
            this.server?.off('listening', onListening);
            reject(error);
          };
          const onListening = () => {
            this.server?.off('error', onError);
            resolve();
          };
          this.server.once('error', onError);
          this.server.once('listening', onListening);
          this.server.listen(port, host);
        });
        return;
      } catch (error) {
        this.server?.close();
        this.server?.removeAllListeners();
        if (error?.code === 'EADDRINUSE' && attempt < attempts) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          this.server = createServer(this.requestListener);
          continue;
        }
        if (error?.code === 'EADDRINUSE') {
          throw new UndermindAuthError(
            'port_in_use',
            `回调端口 ${port} 已被占用。请关闭占用该端口的程序，或在插件设置里把 redirectUri 改成另一个回环端口（并同步更新 client 的 redirect_uris）。`,
          );
        }
        throw new UndermindAuthError('listen_failed', `监听回调端口失败：${error?.message ?? error}`);
      }
    }
  }

  async start() {
    const { host, port } = listenAddressOf(this.settings.redirectUri);
    const callbackPath = callbackPathOf(this.settings.redirectUri);
    this.requestListener = (req, res) => {
      this.onRequest(req, res, callbackPath);
    };
    this.server = createServer(this.requestListener);
    await this.listenWithRetry(host, port);
    const authorizeUrl = buildAuthorizeUrl(this.settings, {
      state: this.state,
      challenge: this.pkce.challenge,
    });
    return { authorizeUrl, redirectUri: this.settings.redirectUri, state: this.state };
  }

  onRequest(req, res, callbackPath) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    if (url.pathname !== callbackPath) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const error = url.searchParams.get('error');
    if (error) {
      const description = url.searchParams.get('error_description') ?? '';
      const message = description ? `${error}: ${description}` : error;
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderPage('授权失败', message, 'error'));
      this.finish({ ok: false, error: new UndermindAuthError('authorize_denied', `Undermind 授权被拒绝：${message}`) });
      return;
    }
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderPage('授权回调缺少参数', '回调里没有 code，请重新发起授权。', 'error'));
      this.finish({ ok: false, error: new UndermindAuthError('missing_code', '授权回调缺少 code 参数。') });
      return;
    }
    if (state !== this.state) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderPage('授权状态不匹配', 'state 校验失败，请重新发起授权。', 'error'));
      this.finish({ ok: false, error: new UndermindAuthError('state_mismatch', '授权回调的 state 与请求不一致。') });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      renderPage(
        '授权已收到',
        'Undermind 授权码已收到，正在换取令牌……\n完成后可以关闭本页面，回到 DeepSeek Harness 继续。',
        'ok',
      ),
    );
    this.finish({ ok: true, code });
  }

  finish(result) {
    if (this.result) return;
    this.result = result;
    this.settle(result);
  }

  /** 等用户在浏览器完成授权；超时或关闭时返回失败。 */
  async wait(timeoutMs) {
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        resolve({
          ok: false,
          error: new UndermindAuthError(
            'login_timeout',
            `等待授权超时（${Math.round(timeoutMs / 1000)} 秒）。请重新调用 undermind_auth（action="login"）。`,
          ),
        });
      }, timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([this.settled, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (!this.result) {
      this.result = { ok: false, error: new UndermindAuthError('login_aborted', '登录流程已关闭。') };
      this.settle(this.result);
    }
    const server = this.server;
    this.server = null;
    if (!server) return;
    try {
      if (server.listening) {
        server.close();
      } else {
        server.removeAllListeners();
      }
    } catch {
      /* 已关闭 */
    }
  }
}

/** 用系统默认浏览器打开 URL（不经 shell，URL 里的 & 不会被解释）。 */
export function openInBrowser(url) {
  if (process.platform === 'win32') {
    const child = spawn('rundll32', ['url.dll,FileProtocolHandler', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => {});
    child.unref();
    return true;
  }
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(command, [url], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return true;
}
