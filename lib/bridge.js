/**
 * 把 Undermind MCP 暴露的工具注册进 dsh 工具表（公开名 `mcp__undermind__*`）。
 *
 * 换新策略与 dsh-plugin-zotero 一致：先拿新清单、再拆旧代、最后建新代；
 * 建新代中途失败就回滚，避免留下半套注册（同名重复注册会直接报错）。
 */

/** 单次工具结果转换为模型可见文本的上限，防止 PDF 全文把一次回复撑爆。 */
const MAX_RENDER_CHARS = 400_000;

function toToolName(prefix, rawName) {
  const safe = rawName.replace(/[^A-Za-z0-9_]/gu, '_');
  return `${prefix}${safe}`;
}

/** MCP 工具名 → 人读标题，用于 dsh 工具列表。 */
function titleOf(tool) {
  const title = typeof tool.title === 'string' ? tool.title : '';
  if (title) return title;
  return tool.name.replace(/[_-]+/gu, ' ');
}

function blocksToText(blocks, fallback) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    if (fallback === undefined || fallback === null) return '（Undermind 没有返回内容）';
    return typeof fallback === 'string' ? fallback : JSON.stringify(fallback, null, 2);
  }
  const parts = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') {
      parts.push(String(block));
      continue;
    }
    switch (block.type) {
      case 'text':
        parts.push(typeof block.text === 'string' ? block.text : JSON.stringify(block));
        break;
      case 'image': {
        const bytes = typeof block.data === 'string' ? block.data.length : 0;
        parts.push(`［图片${block.mimeType ? ` ${block.mimeType}` : ''}，约 ${bytes} 字节，未在文本里展开］`);
        break;
      }
      case 'audio': {
        parts.push(`［音频${block.mimeType ? ` ${block.mimeType}` : ''}，未在文本里展开］`);
        break;
      }
      case 'resource': {
        const resource = block.resource ?? {};
        if (typeof resource.text === 'string') {
          parts.push(resource.text);
        } else if (resource.uri) {
          parts.push(`［资源］${resource.uri}`);
        } else {
          parts.push(JSON.stringify(block));
        }
        break;
      }
      case 'resource_link': {
        parts.push(`［资源链接］${block.name ?? ''} ${block.uri ?? ''}`.trim());
        break;
      }
      default:
        parts.push(JSON.stringify(block));
    }
  }
  let text = parts.join('\n\n');
  if (text.length > MAX_RENDER_CHARS) {
    text = `${text.slice(0, MAX_RENDER_CHARS)}\n\n…（结果过长，已截断 ${text.length - MAX_RENDER_CHARS} 字符）`;
  }
  return text;
}

/**
 * MCP 的 inputSchema 直接当 dsh 的参数 schema 用；只做两件必要清理：
 * 去掉 dsh 不认识的 `$schema`，以及在出现 dsh 子集不支持的 `$ref` 时降级为
 * 「任意对象」——宁可让模型自由传参，也不要让整个工具注册失败。
 */
function normalizeParameters(inputSchema) {
  if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
    return { type: 'object', properties: {} };
  }
  const clone = JSON.parse(JSON.stringify(inputSchema));
  delete clone.$schema;
  if (containsRef(clone)) {
    const description = typeof clone.description === 'string' ? clone.description : '';
    return {
      type: 'object',
      description: description || '参数结构由 Undermind 服务端校验（原始 schema 含 $ref，已降级为自由对象）。',
      properties: {},
      additionalProperties: true,
    };
  }
  if (clone.type !== 'object') {
    clone.type = 'object';
    clone.properties = clone.properties ?? {};
  }
  return clone;
}

function containsRef(node, depth = 0) {
  if (depth > 12 || node === null || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some((item) => containsRef(item, depth + 1));
  if (typeof node.$ref === 'string') return true;
  return Object.values(node).some((value) => containsRef(value, depth + 1));
}

function definitionFor(tool, context) {
  const rawName = tool.name;
  return {
    name: toToolName(context.prefix, rawName),
    description: [titleOf(tool), tool.description].filter((part) => typeof part === 'string' && part.length > 0).join(' —— '),
    parameters: normalizeParameters(tool.inputSchema),
    output: {
      schema: {
        type: 'object',
        properties: {
          content: { type: 'array', items: {} },
          isError: { type: 'boolean' },
          structuredContent: {},
        },
        required: ['content'],
        additionalProperties: true,
      },
      render: (_args, value) => [
        { type: 'text', text: blocksToText(value?.content, value?.structuredContent) },
      ],
    },
    async execute(args, exec) {
      const result = await context.callTool(rawName, args, exec?.signal);
      return {
        content: Array.isArray(result.content) ? result.content : [],
        isError: result.isError === true,
        structuredContent: result.structuredContent,
      };
    },
  };
}

export class McpToolBridge {
  constructor(ctx) {
    this.ctx = ctx;
    this.disposers = [];
    this.lastError = null;
    this.lastSyncAt = 0;
    this.registeredNames = [];
    this.queue = Promise.resolve();
  }

  disposeGeneration() {
    const disposers = this.disposers.splice(0);
    for (const dispose of disposers) {
      try {
        dispose();
      } catch (error) {
        console.warn('[dsh-plugin-undermind] 注销工具失败：', error);
      }
    }
    this.registeredNames = [];
  }

  dispose() {
    this.disposeGeneration();
  }

  /** 串行化 sync，避免登录回调与工具调用同时重建注册表。 */
  sync(options) {
    const run = () => this.syncOnce(options);
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  async syncOnce({ listTools, settings } = {}) {
    this.lastError = null;
    let tools;
    try {
      tools = await listTools();
    } catch (error) {
      this.lastError = { code: error?.code ?? 'error', message: error?.message ?? String(error) };
      this.disposeGeneration();
      this.lastSyncAt = Date.now();
      return { ok: false, registered: [], error: this.lastError };
    }
    const disabled = new Set(settings.disabledTools ?? []);
    const usable = tools.filter((tool) => !disabled.has(tool.name));

    // 先拆旧代：若新代注册失败，旧代也已经不在了 —— 但至少不会出现半套。
    this.disposeGeneration();
    const context = {
      prefix: settings.toolPrefix,
      callTool: (name, args, signal) => this.callTool(name, args, signal),
    };
    const disposers = [];
    const names = [];
    try {
      for (const tool of usable) {
        const definition = definitionFor(tool, context);
        const dispose = this.ctx.tools.register(definition);
        disposers.push(typeof dispose === 'function' ? dispose : () => {});
        names.push(definition.name);
      }
    } catch (error) {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* 回滚失败时忽略 */
        }
      }
      this.lastError = { code: error?.code ?? 'register_failed', message: error?.message ?? String(error) };
      this.lastSyncAt = Date.now();
      return { ok: false, registered: [], error: this.lastError };
    }
    this.disposers = disposers;
    this.registeredNames = names;
    this.lastSyncAt = Date.now();
    return {
      ok: true,
      registered: names,
      skipped: tools.length - usable.length,
      tools: usable.map((tool) => ({ name: tool.name, title: titleOf(tool), description: tool.description ?? '' })),
    };
  }

  async callTool(rawName, args, signal) {
    const caller = this.currentCallTool;
    if (!caller) throw new Error('Undermind MCP 客户端尚未就绪。');
    return caller(rawName, args, signal);
  }

  /** 由插件入口注入真正的 MCP 调用实现（保持 bridge 与传输层解耦）。 */
  setCallTool(caller) {
    this.currentCallTool = caller;
  }
}
