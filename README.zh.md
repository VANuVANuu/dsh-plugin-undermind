# dsh-plugin-undermind

[English](README.md) | 中文

把 [Undermind](https://www.undermind.ai/)（学术文献检索与深度综述服务）接进
DeepSeek Harness（dsh）。你用自己的话描述研究目标，它返回按相关度排序的论文列表，
并提供 PDF 精读与工作区归档。安装后模型可以直接调用
`mcp__undermind__launch_deep_search`、`mcp__undermind__search_papers`、
`mcp__undermind__read_pdfs` 等工具。

## 为什么需要插件

Undermind 的 MCP 端点 `https://mcp.undermind.ai/mcp` 只接受 `Authorization: Bearer`，
令牌走授权码 + PKCE（公共客户端、无 secret）。access token 1 小时过期，refresh token
每次使用后轮换。dsh 自带的 `@deepseek-ai/dsh-mcp-client` 只透传静态 headers，没有续期
能力，撑不住这条连接。所以本插件自己维护它：

- **OAuth/PKCE 登录**：一次性回环回调服务 + 系统默认浏览器。
- **令牌落盘与自动续期**：写到 `$DSH_HOME/storages/undermind-mcp-auth.json`（`0600`、
  原子替换），到期前 90 秒刷新；遇到 `401` 强制刷新并重试一次；轮换后的 refresh token
  立即覆盖旧值。
- **MCP 会话**：`initialize` → `notifications/initialized`，之后每次调用带
  `mcp-session-id`；支持 JSON 与 `text/event-stream` 响应；服务端返回 `404` 时重建会话。
- **工具注册**：`tools/list` 返回什么就注册什么，公开名带 `mcp__undermind__` 前缀。
  未授权时不注册任何工具；换账号或换 client id 会整体替换上一代工具。
- **常驻 `undermind_auth` 工具**：`status` / `login` / `logout` / `refresh` / `retry`，
  模型可以在对话里直接修复连接。
- **Host HTTP 接口**：`/dsh-undermind/api/*`，用于浏览器侧授权与排查。

## 前置条件

1. **一个 Undermind 账号**。每家用户用自己的账号授权，没有 API key / 服务账号模式。
2. **一个 client id**。Undermind **不支持动态客户端注册（DCR）**，只接受：

   - **CIMD**：一个 HTTPS URL，指向 Client ID Metadata Document（JSON），Undermind 会去
     拉取它；或
   - **预注册 client id**：发邮件到 [`support@undermind.ai`](mailto:support@undermind.ai) 申请。

   CIMD 是自助路径。把下面这份 JSON 托管到任意你控制的 HTTPS 地址，再把该地址填进
   `clientId`：

   ```json
   {
     "client_id": "https://example.com/undermind-client-metadata.json",
     "client_name": "DeepSeek Harness",
     "redirect_uris": ["http://127.0.0.1:8799/callback"],
     "grant_types": ["authorization_code", "refresh_token"],
     "response_types": ["code"],
     "token_endpoint_auth_method": "none",
     "scope": "mcp"
   }
   ```

   该地址必须返回 `application/json`。GitHub 的 `raw.githubusercontent.com` 返回
   `text/plain`，所以 Gist 需要一个会带 JSON 类型的镜像（`gist.githack.com` 的 raw 地址
   可以）；GitHub Pages 直接可用。`client_id` 必须与 URL 逐字一致，`redirect_uris` 必须
   包含插件的 `redirectUri`——以后挪动文档位置时，两者要一起改。

   `GET /dsh-undermind/api/client-metadata` 会打印带上当前 `redirectUri` 的模板。

## 安装

```sh
dsh plugin --profile web add github:VANuVANuu/dsh-plugin-undermind
```

把 `web` 换成你的 profile 名。本包是纯 ESM、无构建步骤，并把 `@deepseek-ai/cordis` /
`@deepseek-ai/schemastery` 声明为 peer 依赖，与宿主共用同一份，不额外打包。

Desktop 客户端持有的 profile 特殊：`desktop` 这个名字由 Electron 保留，`dsh plugin`
CLI 会拒绝它。这种情况下从插件市场安装，或把包放进
`profiles/desktop/node_modules` 并把 `dsh-plugin-undermind` 加进
`dsh.profile.bundles`。

**不要**再为这个 server 添加 `@deepseek-ai/dsh-mcp-client`：它无法续期令牌，而且它的
工具名会与本插件重名。

## 配置项

每个字段都是活引用，设置页保存后下一次调用即生效，不用重启。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `clientId` | 空 | **必填**。CIMD 的 HTTPS URL 或预注册 client id。 |
| `mcpUrl` | `https://mcp.undermind.ai/mcp` | MCP 端点，同时作为 OAuth `resource`。 |
| `scope` | `mcp` | 申请的范围。 |
| `redirectUri` | `http://127.0.0.1:8799/callback` | 回环回调地址，必须在 client 文档里登记。 |
| `authorizeEndpoint` | `https://api.undermind.ai/o/authorize/` | 授权端点。 |
| `tokenEndpoint` | `https://api.undermind.ai/o/token/` | 令牌端点。 |
| `revocationEndpoint` | `https://api.undermind.ai/o/revoke_token/` | 撤销端点，登出时调用。 |
| `tokenFile` | 空 | 空表示 `$DSH_HOME/storages/undermind-mcp-auth.json`。 |
| `requestTimeoutMs` | `30000` | 单次 MCP 请求超时。 |
| `toolTimeoutMs` | `180000` | 单次工具调用超时；深度检索与 PDF 精读都很慢。 |
| `loginTimeoutMs` | `600000` | 等待浏览器授权的上限。 |
| `toolPrefix` | `mcp__undermind__` | 注册到 dsh 的工具名前缀。 |
| `disabledTools` | `[]` | 要隐藏的 Undermind 原始工具名，例如 `["write_file"]`。 |

## 使用

### 第一次授权

对模型说「把 Undermind 连上」，或直接调用：

```
undermind_auth action="login"
```

插件会在 `redirectUri` 的端口上启动一次性回调服务，用 `state` 与 PKCE 拼出授权 URL，
**在系统默认浏览器里打开**。你同意后浏览器跳到 `127.0.0.1:8799/callback`，插件用授权码
换令牌、落盘，然后拉取并注册全部工具。`mcp__undermind__*` 对模型立即可见；
`undermind_auth action="status"` 会给出 `toolCount` 与已注册的工具名。

### 日常使用

- 「查一下 2024 年以来镁离子电池电解液的进展」→ `launch_deep_search`（异步深度检索，
  跑几分钟，用 `inspect_deep_searches` 轮询）。
- 「找和这段摘要相似的论文」→ `search_papers`。
- 「读这几篇 PDF，说说它们用了什么方法」→ `read_pdfs`（每篇一个子代理读全文，含图表）。
- 「把这些论文归到一个新文件夹」→ `create_folder` / `add_papers_to_folder`。

`display_deep_search_results`、`display_references`、`suggest_pdf_uploads` 这三个在支持
MCP Apps 的 agent 里是交互卡片；在 dsh 里只返回文本和链接。

### 排查

| 现象 | 处理 |
|---|---|
| `missing_client_id` | 填 `clientId`，见上面的 CIMD 文档模板。 |
| 授权后仍无工具 | `undermind_auth action="retry"`，再看 `lastError`。 |
| `port_in_use` | 8799 被占用：释放它，或把 `redirectUri` 与 client 文档一起改。 |
| `401` / `not_authorized` | 授权被撤销或已过刷新期：`undermind_auth action="login"`。 |
| 换了 `clientId` | 旧 client 的令牌不会被复用，需要重新授权。 |

### HTTP 接口

只接受回环来源：`Host` 必须是 `localhost` / `127.0.0.1` / `[::1]`，带
`sec-fetch-site: cross-site` 的请求一律拒绝。

| 路由 | 作用 |
|---|---|
| `GET /dsh-undermind/api/status` | 授权状态、令牌剩余时间、工具数、最近错误。 |
| `GET\|POST /dsh-undermind/api/tools` | 重新拉取并注册工具。 |
| `POST /dsh-undermind/api/login` | 发起授权，返回 `authorizeUrl`。 |
| `POST /dsh-undermind/api/logout` | 撤销并删除本地令牌。 |
| `GET /dsh-undermind/api/client-metadata` | 带当前 `redirectUri` 的 CIMD 模板。 |

统一信封：成功 `{"ok":true,"data":…}`，失败 `{"ok":false,"error":{"code","message"}}`。

## 安全与隐私

- 令牌不出本机：写在 `$DSH_HOME/storages/` 下，`0600` 权限、原子替换。
- 令牌只会发往 `api.undermind.ai` 与 `mcp.undermind.ai`。
- 回调服务只监听回环地址，只接受一次授权码，用完立即关闭。
- 你随时可以在 Undermind 账号设置里撤销该连接。

## 目录结构

```
lib/index.js    插件入口：Config、apply、登录编排、auth 工具、路由挂载
lib/settings.js 运行期设置（volatile 读取器）
lib/store.js    令牌文件读写（原子 + 0600）
lib/auth.js     TokenManager：续期、轮换、撤销、状态
lib/oauth.js    PKCE、授权 URL、授权码交换、回调服务、开浏览器
lib/mcp.js      MCP Streamable HTTP 客户端（initialize/会话/SSE/401 自愈）
lib/bridge.js   MCP 工具 → dsh 工具注册（分代替换、schema 降级）
lib/router.js   /dsh-undermind/api/* 路由与 CIMD 模板
```
