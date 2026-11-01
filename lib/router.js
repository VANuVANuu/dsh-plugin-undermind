/**
 * Host 侧 HTTP 路由：`/dsh-undermind/api/<action>`。
 *
 * 统一信封 `{ok:true,data}` / `{ok:false,error:{code,message}}`，只挂在 dsh 自己的
 * web server 上，供设置页/本地面板查看授权状态、发起登录、登出与重建工具注册。
 * 信任栅栏与 dsh-plugin-zotero 相同：拒绝 `sec-fetch-site: cross-site`，且
 * Host 头必须是回环地址（防 DNS rebinding）。
 */

export const ROUTE_PREFIX = '/dsh-undermind/api/';
export const ROUTE_MATCH = '/dsh-undermind/api';

function isLoopbackHost(hostHeader) {
  if (!hostHeader) return false;
  const host = hostHeader.replace(/:\d+$/u, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

function isTrusted(req) {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site.toLowerCase() === 'cross-site') return false;
  return isLoopbackHost(req.headers.host);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function ok(res, data) {
  sendJson(res, 200, { ok: true, data });
}

function fail(res, status, code, message) {
  sendJson(res, status, { ok: false, error: { code, message } });
}

/** 消费请求体，避免 keep-alive 连接挂住（这些端点都不用 body）。 */
async function drain(req) {
  try {
    for await (const _chunk of req) {
      /* 丢弃 */
    }
  } catch {
    /* 客户端断开 */
  }
}

function toApiError(error) {
  const code = typeof error?.code === 'string' ? error.code : 'internal_error';
  const message = error?.message ?? String(error);
  const status =
    code === 'not_authorized' || code === 'expired_no_refresh' ? 401
      : code === 'missing_client_id' || code === 'bad_request' ? 400
        : code === 'port_in_use' ? 409
          : 500;
  return { status, error: { code, message } };
}

/** 建议的 Client ID Metadata Document 内容（用户自行托管到 HTTPS 后当 clientId 用）。 */
export function clientMetadataTemplate(settings) {
  const document = {
    client_id: 'https://<你的域名>/undermind-client-metadata.json',
    client_name: 'DeepSeek Harness',
    client_uri: 'https://github.com/deepseek-ai',
    redirect_uris: [settings.redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: settings.scope || 'mcp',
  };
  return {
    document,
    notes: [
      'Undermind 不支持动态客户端注册（DCR），client_id 只能是 HTTPS 的 Client ID Metadata Document URL，或向其团队预注册的 client id。',
      '把上面 document 里的 client_id 换成你实际托管该 JSON 的 HTTPS 地址（两者必须完全一致），redirect_uris 必须包含本插件的 redirectUri。',
      '托管后把该 HTTPS 地址填进插件设置 clientId。',
      '也可以发邮件到 support@undermind.ai 申请预注册 client id。',
    ],
  };
}

/** 构造挂在 `webServer` 上的前缀路由处理器。 */
export function createHandler(deps) {
  const handler = async (req, res) => {
    if (!isTrusted(req)) {
      await drain(req);
      fail(res, 403, 'forbidden', '拒绝非回环来源的请求');
      return;
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    if (!url.pathname.startsWith(ROUTE_PREFIX)) {
      await drain(req);
      fail(res, 404, 'not_found', `未知路由 ${url.pathname}`);
      return;
    }
    const action = url.pathname.slice(ROUTE_PREFIX.length).replace(/\/+$/u, '');
    try {
      switch (action) {
        case 'status': {
          if (req.method !== 'GET') {
            await drain(req);
            fail(res, 405, 'bad_request', 'status 只支持 GET');
            return;
          }
          ok(res, await deps.status());
          return;
        }
        case 'tools': {
          if (req.method !== 'GET' && req.method !== 'POST') {
            await drain(req);
            fail(res, 405, 'bad_request', 'tools 只支持 GET/POST');
            return;
          }
          await drain(req);
          ok(res, await deps.sync());
          return;
        }
        case 'login': {
          if (req.method !== 'POST') {
            await drain(req);
            fail(res, 405, 'bad_request', 'login 只支持 POST');
            return;
          }
          await drain(req);
          ok(res, await deps.login());
          return;
        }
        case 'logout': {
          if (req.method !== 'POST') {
            await drain(req);
            fail(res, 405, 'bad_request', 'logout 只支持 POST');
            return;
          }
          await drain(req);
          ok(res, await deps.logout());
          return;
        }
        case 'client-metadata': {
          if (req.method !== 'GET') {
            await drain(req);
            fail(res, 405, 'bad_request', 'client-metadata 只支持 GET');
            return;
          }
          ok(res, clientMetadataTemplate(deps.settings()));
          return;
        }
        default:
          await drain(req);
          fail(res, 404, 'not_found', `未知 action ${action}`);
      }
    } catch (error) {
      const { status, error: apiError } = toApiError(error);
      fail(res, status, apiError.code, apiError.message);
    }
  };
  return handler;
}
