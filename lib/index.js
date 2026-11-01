/**
 * dsh-plugin-undermind —— 把 Undermind（https://www.undermind.ai）的学术检索
 * MCP 服务接进 DeepSeek Harness。
 *
 * 三件事：
 * 1. 自持 OAuth（authorization code + PKCE，公共客户端）令牌：落盘、
 *    到期自动刷新、401 时强制刷新重试。Undermind 的 MCP 端点
 *    https://mcp.undermind.ai/mcp 只认 Bearer，而 dsh 自带的
 *    `dsh-mcp-client` 没有令牌续期能力，所以连接由本插件自己维护。
 * 2. 把 Undermind 的工具注册进 dsh 工具表（公开名 `mcp__undermind__*`），
 *    外加一个常驻的 `undermind_auth` 工具用于查状态 / 发起登录 / 登出。
 * 3. 在 dsh 自己的 web server 上暴露 `/dsh-undermind/api/*`（状态、登录、
 *    登出、工具清单、CIMD 模板），方便用户在浏览器里完成授权。
 *
 * Undermind 不支持 Dynamic Client Registration：client_id 必须是 HTTPS 的
 * Client ID Metadata Document URL 或向其团队预注册的 client id，因此
 * `clientId` 是必填配置项。
 */
import Schema from '@deepseek-ai/schemastery';
import { UndermindAuthError, tokenManager } from './auth.js';
import { McpToolBridge } from './bridge.js';
import { McpClient, McpError } from './mcp.js';
import { LoginFlow, exchangeCode, openInBrowser } from './oauth.js';
import { createHandler, ROUTE_MATCH } from './router.js';
import { DEFAULTS, getSettings, setSettingsReader } from './settings.js';

export const name = 'dsh-plugin-undermind';

/** 与 settings.js 的 DEFAULTS 一一对应；每字段 volatile 才能被 dsh 插件页读写。 */
export const Config = Schema.object({
  mcpUrl: Schema.string().default(DEFAULTS.mcpUrl).volatile(),
  clientId: Schema.string().default(DEFAULTS.clientId).volatile(),
  scope: Schema.string().default(DEFAULTS.scope).volatile(),
  redirectUri: Schema.string().default(DEFAULTS.redirectUri).volatile(),
  authorizeEndpoint: Schema.string().default(DEFAULTS.authorizeEndpoint).volatile(),
  tokenEndpoint: Schema.string().default(DEFAULTS.tokenEndpoint).volatile(),
  revocationEndpoint: Schema.string().default(DEFAULTS.revocationEndpoint).volatile(),
  tokenFile: Schema.string().default(DEFAULTS.tokenFile).volatile(),
  requestTimeoutMs: Schema.number().default(DEFAULTS.requestTimeoutMs).volatile(),
  toolTimeoutMs: Schema.number().default(DEFAULTS.toolTimeoutMs).volatile(),
  loginTimeoutMs: Schema.number().default(DEFAULTS.loginTimeoutMs).volatile(),
  toolPrefix: Schema.string().default(DEFAULTS.toolPrefix).volatile(),
  disabledTools: Schema.array(Schema.string()).default([]).volatile(),
});

const AUTH_TOOL_NAME = 'undermind_auth';

const AUTH_TOOL_DESCRIPTION = [
  '查看或修复 Undermind（学术文献检索服务）的授权状态。',
  '当 mcp__undermind__* 工具不可用、返回 401 或提示未授权时，先用 action="status" 查看状态；',
  '需要授权时用 action="login"，它会给出一条 OAuth 授权链接并在系统默认浏览器里打开，',
  '用户在自己的 Undermind 账号里同意后，工具会自动注册进来（可用 action="status" 确认）。',
  'action="refresh" 强制刷新访问令牌；action="logout" 断开当前账号；action="retry" 重新拉取并注册工具。',
].join('');

function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}

/** 把传输层/授权层错误转成模型看得懂的工具错误。 */
function normalizeToolError(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (
    code === 'unauthorized'
    || code === 'not_authorized'
    || code === 'expired_no_refresh'
    || code === 'refresh_rejected'
    || code === 'refresh_failed'
    || code === 'missing_client_id'
  ) {
    const hint = code === 'missing_client_id'
      ? '请在 dsh 的插件设置里填写 clientId（Client ID Metadata Document 的 HTTPS URL，或向 Undermind 预注册的 client id），然后调用 undermind_auth（action="login"）。'
      : '请调用 undermind_auth：先 action="status" 查看状态，再 action="login" 重新授权。';
    return new Error(`Undermind 授权不可用（${code}）：${error.message} ${hint}`);
  }
  if (error instanceof McpError) {
    return new Error(`Undermind MCP 调用失败（${error.code}）：${error.message}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

export function apply(ctx, config) {
  // 每次读取都走 volatile 引用，配置保存后无需重启即可生效。
  setSettingsReader(() => ({
    mcpUrl: config.mcpUrl.get(),
    clientId: config.clientId.get(),
    scope: config.scope.get(),
    redirectUri: config.redirectUri.get(),
    authorizeEndpoint: config.authorizeEndpoint.get(),
    tokenEndpoint: config.tokenEndpoint.get(),
    revocationEndpoint: config.revocationEndpoint.get(),
    tokenFile: config.tokenFile.get(),
    requestTimeoutMs: config.requestTimeoutMs.get(),
    toolTimeoutMs: config.toolTimeoutMs.get(),
    loginTimeoutMs: config.loginTimeoutMs.get(),
    toolPrefix: config.toolPrefix.get(),
    disabledTools: [...config.disabledTools.get()],
  }));

  /** 共享的 MCP 客户端；设置变化时由 syncTools/listTools 重新 configure。 */
  const client = new McpClient({
    getAccessToken: (options) => tokenManager.getAccessToken(getSettings(), options),
    onInvalidToken: async () => {
      await tokenManager.refresh(getSettings());
    },
  });

  let bridge;
  /** 进行中的登录尝试（同一时刻只允许一条，避免端口/state 打架）。 */
  let pendingLogin = null;
  let lastLogin = null;

  async function status() {
    const settings = getSettings();
    const authStatus = await tokenManager.status(settings);
    return {
      ...authStatus,
      mcpUrl: settings.mcpUrl,
      redirectUri: settings.redirectUri,
      toolPrefix: settings.toolPrefix,
      registeredTools: bridge?.registeredNames ?? [],
      toolCount: bridge?.registeredNames?.length ?? 0,
      lastSyncAt: bridge?.lastSyncAt ?? 0,
      lastError: bridge?.lastError ?? null,
      lastLogin,
      loginPending: Boolean(pendingLogin),
    };
  }

  async function listTools() {
    const settings = getSettings();
    client.configure(settings);
    return client.listTools();
  }

  async function syncTools() {
    if (!bridge) {
      return { ok: false, registered: [], error: { code: 'not_ready', message: 'dsh 工具服务尚未就绪。' } };
    }
    const settings = getSettings();
    client.configure(settings);
    const authStatus = await tokenManager.status(settings);
    if (!authStatus.authorized) {
      bridge.disposeGeneration();
      bridge.lastError = { code: 'not_authorized', message: '尚未授权 Undermind。' };
      bridge.lastSyncAt = Date.now();
      return { ok: false, registered: [], error: bridge.lastError };
    }
    bridge.setCallTool(async (rawName, args, signal) => {
      try {
        return await client.callTool(rawName, args, { signal, timeoutMs: settings.toolTimeoutMs });
      } catch (error) {
        throw normalizeToolError(error);
      }
    });
    return bridge.sync({ listTools, settings });
  }

  async function login() {
    const settings = getSettings();
    if (pendingLogin) {
      openInBrowser(pendingLogin.authorizeUrl);
      return {
        authorizeUrl: pendingLogin.authorizeUrl,
        redirectUri: settings.redirectUri,
        opened: true,
        reused: true,
        message: '已有一条登录流程在进行，重新打开了同一个授权链接。',
      };
    }
    if (!settings.clientId) {
      throw new UndermindAuthError(
        'missing_client_id',
        '未配置 clientId。Undermind 只接受 HTTPS 的 Client ID Metadata Document URL 或预注册 client id（不支持动态客户端注册）；请先在插件设置里填写 clientId。可访问 /dsh-undermind/api/client-metadata 取得模板。',
      );
    }
    const flow = new LoginFlow(settings);
    const { authorizeUrl, redirectUri } = await flow.start();
    openInBrowser(authorizeUrl);
    const session = { authorizeUrl, redirectUri, startedAt: Date.now() };
    pendingLogin = session;
    session.completion = (async () => {
      try {
        const result = await flow.wait(settings.loginTimeoutMs);
        if (!result.ok) {
          lastLogin = { ok: false, at: new Date().toISOString(), code: result.error.code, message: result.error.message };
          return;
        }
        const json = await exchangeCode(settings, { code: result.code, verifier: flow.pkce.verifier });
        const state = await tokenManager.acceptTokenResponse(settings, json, { clientId: settings.clientId });
        lastLogin = {
          ok: true,
          at: new Date().toISOString(),
          scope: state.scope,
          expiresAt: state.expiresAt,
        };
        await syncTools();
      } catch (error) {
        lastLogin = {
          ok: false,
          at: new Date().toISOString(),
          code: error?.code ?? 'error',
          message: error?.message ?? String(error),
        };
        console.warn('[dsh-plugin-undermind] 授权流程失败：', error);
      } finally {
        flow.close();
        if (pendingLogin === session) pendingLogin = null;
      }
    })();
    return {
      authorizeUrl,
      redirectUri,
      opened: true,
      message: '已在系统浏览器中打开 Undermind 授权页；在浏览器里同意后，mcp__undermind__* 工具会自动注册。',
    };
  }

  async function logout() {
    const settings = getSettings();
    const result = await tokenManager.signOut(settings);
    client.resetSession();
    bridge?.disposeGeneration();
    lastLogin = null;
    return { ...result, registeredTools: [] };
  }

  async function refresh() {
    const settings = getSettings();
    const state = await tokenManager.refresh(settings);
    return {
      ok: true,
      scope: state.scope,
      expiresAt: state.expiresAt,
      expiresInSeconds: Math.max(0, Math.round((state.expiresAt - Date.now()) / 1000)),
    };
  }

  function buildAuthToolResult(action) {
    return async () => {
      switch (action) {
        case 'status':
          return await status();
        case 'login':
          return await login();
        case 'logout':
          return await logout();
        case 'refresh':
          return await refresh();
        case 'retry':
          return await syncTools();
        default:
          throw new Error(`未知 action：${action}`);
      }
    };
  }

  // 模型侧：常驻的 undermind_auth +（已授权时）Undermind 的全部工具。
  ctx.inject(['tools'], (toolCtx) => {
    const instance = new McpToolBridge(toolCtx);
    bridge = instance;
    const disposeAuthTool = toolCtx.tools.register({
      name: AUTH_TOOL_NAME,
      description: AUTH_TOOL_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'login', 'logout', 'refresh', 'retry'],
            description: 'status=查看授权与工具状态；login=打开浏览器授权；logout=断开账号；refresh=强制刷新令牌；retry=重新拉取并注册工具。',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: {}, additionalProperties: true },
        render: renderJson,
      },
      async execute(args, exec) {
        if (exec?.signal?.aborted) throw new Error('调用已取消。');
        const action = String(args?.action ?? '').trim();
        try {
          return await buildAuthToolResult(action)();
        } catch (error) {
          throw normalizeToolError(error);
        }
      },
    });

    toolCtx.effect(() => () => {
      try {
        disposeAuthTool();
      } catch {
        /* 已释放 */
      }
      instance.dispose();
      if (bridge === instance) bridge = undefined;
    }, 'dsh-plugin-undermind: auth tool + mcp bridge');

    instance.setCallTool(async (rawName, args, signal) => {
      try {
        return await client.callTool(rawName, args, { signal, timeoutMs: getSettings().toolTimeoutMs });
      } catch (error) {
        throw normalizeToolError(error);
      }
    });
    syncTools().catch((error) => {
      console.warn('[dsh-plugin-undermind] 初始同步 Undermind 工具失败：', error);
    });
  });

  // Host 侧：设置页/本地面板用的 HTTP 接口。
  ctx.inject(['webServer'], (hostCtx) => {
    const handler = createHandler({
      status,
      sync: syncTools,
      login,
      logout,
      settings: getSettings,
    });
    hostCtx.effect(
      () => hostCtx.webServer.register({ kind: 'prefix', path: ROUTE_MATCH, handler }),
      'dsh-plugin-undermind: http routes',
    );
  });
}
