/**
 * MCP Streamable HTTP 客户端（JSON-RPC 2.0 over POST，SSE 或 JSON 响应）。
 *
 * dsh 自带的 `@deepseek-ai/dsh-mcp-client` 只把静态 headers 传给传输层，没有
 * OAuth 续期能力；Undermind 的 access token 只有 1 小时，所以这里自持一个
 * 最小客户端，并在 401 时强制刷新令牌重试、在 404（session 终止）时重新握手。
 */

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'dsh-plugin-undermind', version: '0.1.0' };

export class McpError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.detail = detail;
  }
}

function isEventStream(contentType) {
  return typeof contentType === 'string' && contentType.toLowerCase().includes('text/event-stream');
}

/** 把 SSE 文本切成 data 帧（忽略注释行与其它字段）。 */
function parseSseFrames(text) {
  const frames = [];
  let dataLines = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    if (rawLine === '') {
      if (dataLines.length > 0) {
        frames.push(dataLines.join('\n'));
        dataLines = [];
      }
      continue;
    }
    if (rawLine.startsWith(':')) continue;
    const idx = rawLine.indexOf(':');
    const field = idx === -1 ? rawLine : rawLine.slice(0, idx);
    if (field !== 'data') continue;
    let value = idx === -1 ? '' : rawLine.slice(idx + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    dataLines.push(value);
  }
  if (dataLines.length > 0) frames.push(dataLines.join('\n'));
  return frames;
}

function parseMessages(contentType, text) {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (!isEventStream(contentType)) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      throw new McpError('parse_error', `MCP 响应不是合法 JSON：${trimmed.slice(0, 300)}`);
    }
  }
  const messages = [];
  for (const frame of parseSseFrames(text)) {
    if (frame.trim() === '' || frame.trim() === '[DONE]') continue;
    try {
      const parsed = JSON.parse(frame);
      if (Array.isArray(parsed)) messages.push(...parsed);
      else messages.push(parsed);
    } catch {
      // 单帧解析失败不致命：服务端可能发心跳或非 JSON 帧。
    }
  }
  return messages;
}

function pickResponse(messages, id) {
  const hasBody = (message) => message && typeof message === 'object' && ('result' in message || 'error' in message);
  for (const message of messages) {
    if (hasBody(message) && message.id === id) return message;
  }
  for (const message of messages) {
    if (hasBody(message) && String(message.id) === String(id)) return message;
  }
  return null;
}

export class McpClient {
  /**
   * @param {object} deps
   * @param {(options?: {forceRefresh?: boolean}) => Promise<string>} deps.getAccessToken
   * @param {() => Promise<void>} [deps.onInvalidToken] 401 时调用（应强制刷新令牌）
   */
  constructor({ getAccessToken, onInvalidToken }) {
    this.getAccessToken = getAccessToken;
    this.onInvalidToken = onInvalidToken;
    this.settings = null;
    this.sessionId = '';
    this.protocolVersion = PROTOCOL_VERSION;
    this.nextId = 1;
    this.inflightInit = null;
  }

  configure(settings) {
    const previousUrl = this.settings?.mcpUrl;
    this.settings = settings;
    if (previousUrl && previousUrl !== settings.mcpUrl) {
      this.resetSession();
    }
    return this;
  }

  resetSession() {
    this.sessionId = '';
    this.protocolVersion = PROTOCOL_VERSION;
    this.inflightInit = null;
  }

  /** 握手一次；并发调用共享同一次 initialize。 */
  async ensureSession({ signal } = {}) {
    if (this.sessionId) return this.sessionId;
    if (this.inflightInit) return this.inflightInit;
    const task = this.initialize({ signal });
    this.inflightInit = task;
    try {
      return await task;
    } finally {
      if (this.inflightInit === task) this.inflightInit = null;
    }
  }

  async initialize({ signal } = {}) {
    const message = {
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
    };
    const result = await this.post(message, { timeoutMs: this.timeout(), signal, initialize: true });
    if (!result) {
      throw new McpError('initialize_failed', 'MCP initialize 没有返回结果。');
    }
    if (typeof result.protocolVersion === 'string' && result.protocolVersion.length > 0) {
      this.protocolVersion = result.protocolVersion;
    }
    // 通知不需要响应；失败也不阻塞（很多实现回 202/204）。
    try {
      await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, {
        timeoutMs: this.timeout(),
        signal,
        notification: true,
      });
    } catch {
      /* 忽略 */
    }
    return this.sessionId;
  }

  timeout() {
    return this.settings?.requestTimeoutMs ?? 30_000;
  }

  async post(message, { timeoutMs, signal, initialize = false, notification = false } = {}) {
    const settings = this.settings;
    if (!settings) throw new McpError('not_configured', 'MCP 客户端尚未配置。');
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (!initialize) headers['mcp-protocol-version'] = this.protocolVersion;
    const token = await this.getAccessToken();
    if (token) headers.authorization = `Bearer ${token}`;
    if (this.sessionId && !initialize) headers['mcp-session-id'] = this.sessionId;

    const timeoutSignal = AbortSignal.timeout(timeoutMs ?? this.timeout());
    const combined = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;

    let response;
    try {
      response = await fetch(settings.mcpUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        signal: combined,
      });
    } catch (error) {
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
        throw new McpError('timeout', `请求 Undermind MCP 超时（${timeoutMs ?? this.timeout()} ms）。`);
      }
      throw new McpError('network_error', `连接 Undermind MCP 失败：${error?.message ?? error}`);
    }

    const sessionId = response.headers.get('mcp-session-id');
    if (sessionId) this.sessionId = sessionId;

    if (response.status === 401) {
      await response.text().catch(() => '');
      throw new McpError('unauthorized', 'Undermind 拒绝访问（HTTP 401），令牌可能已失效。');
    }
    if (response.status === 404 && this.sessionId) {
      await response.text().catch(() => '');
      const error = new McpError('session_expired', 'Undermind MCP 会话已终止（HTTP 404），需要重新握手。');
      this.resetSession();
      throw error;
    }
    if (notification && (response.status === 202 || response.status === 204)) {
      await response.text().catch(() => '');
      return null;
    }
    if (response.status === 204 || response.status === 202) {
      await response.text().catch(() => '');
      return null;
    }

    const contentType = response.headers.get('content-type') ?? '';
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      let detail = text.slice(0, 400);
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.error?.message ?? parsed?.message ?? detail;
      } catch {
        /* 保留原始文本 */
      }
      throw new McpError('http_error', `Undermind MCP 返回 HTTP ${response.status}：${detail}`);
    }

    const messages = parseMessages(contentType, text);
    if (notification) return null;
    const response_ = pickResponse(messages, message.id);
    if (!response_) {
      if (messages.length === 0) {
        throw new McpError('empty_response', 'Undermind MCP 返回了空响应。');
      }
      // 没有匹配 id：可能是服务端在其它流里回复；把原始内容带上便于排查。
      throw new McpError('missing_response', `未在响应中找到 id=${message.id} 的 JSON-RPC 结果。`, messages);
    }
    if (response_.error) {
      const code = response_.error.code ?? 'rpc_error';
      const message_ = response_.error.message ?? 'Undermind MCP 返回错误';
      throw new McpError('rpc_error', message_, response_.error);
    }
    return response_.result;
  }

  /** 发一条 JSON-RPC 请求，并对 401 / 会话失效各做一次自愈重试。 */
  async rpc(method, params, { timeoutMs, signal } = {}) {
    let retriedAuth = false;
    let retriedSession = false;
    for (;;) {
      try {
        await this.ensureSession({ signal });
        return await this.post(
          { jsonrpc: '2.0', id: this.nextId++, method, params: params ?? {} },
          { timeoutMs, signal },
        );
      } catch (error) {
        if (error instanceof McpError && error.code === 'unauthorized' && !retriedAuth) {
          retriedAuth = true;
          if (this.onInvalidToken) {
            await this.onInvalidToken();
            continue;
          }
        }
        if (error instanceof McpError && error.code === 'session_expired' && !retriedSession) {
          retriedSession = true;
          continue;
        }
        throw error;
      }
    }
  }

  async listTools({ signal } = {}) {
    const tools = [];
    let cursor;
    for (let page = 0; page < 25; page += 1) {
      const result = await this.rpc('tools/list', cursor ? { cursor } : {}, { signal });
      const batch = Array.isArray(result?.tools) ? result.tools : [];
      for (const tool of batch) {
        if (tool && typeof tool.name === 'string' && tool.name.length > 0) tools.push(tool);
      }
      cursor = typeof result?.nextCursor === 'string' && result.nextCursor.length > 0 ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(name, args, { signal, timeoutMs } = {}) {
    const result = await this.rpc('tools/call', { name, arguments: args ?? {} }, { signal, timeoutMs });
    return {
      content: Array.isArray(result?.content) ? result.content : [],
      structuredContent: result?.structuredContent,
      isError: result?.isError === true,
    };
  }
}
