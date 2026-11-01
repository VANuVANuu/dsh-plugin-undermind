# dsh-plugin-undermind

English | [中文](README.zh.md)

[Undermind](https://www.undermind.ai/) is an AI literature search service: you describe a
research goal in plain language, and it returns papers ranked by relevance, plus PDF reading
and a workspace to keep them in.

This plugin brings Undermind's remote MCP server
([`https://mcp.undermind.ai/mcp`](https://mcp.undermind.ai/mcp)) into
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`), so the agent can
search the literature, read PDFs and organize what it finds.

## Why this is a plugin and not just an MCP server entry

Undermind's endpoint accepts only `Authorization: Bearer`, issued through OAuth authorization
code + PKCE (public client, no secret). The access token lives one hour, and the refresh token
rotates on every use. dsh's built-in `@deepseek-ai/dsh-mcp-client` forwards static headers and
has no renewal logic, so it cannot hold this connection. This plugin owns it instead:

- **OAuth/PKCE login** — a one-shot loopback callback server plus the system browser.
- **Token storage and refresh** — `$DSH_HOME/storages/undermind-mcp-auth.json`, written `0600`
  and atomically replaced. The token is refreshed 90 seconds before expiry; a `401` triggers a
  forced refresh and one retry; a rotated refresh token is persisted immediately.
- **MCP session handling** — `initialize` → `notifications/initialized`, then
  `mcp-session-id` on every call, JSON or `text/event-stream` responses, and a fresh session
  when the server returns `404`.
- **Tool registration** — everything `tools/list` returns is registered with dsh as
  `mcp__undermind__<name>`. Nothing is registered while unauthorized, and changing the account
  or client id drops the previous generation of tools.
- **`undermind_auth` tool** — `status`, `login`, `logout`, `refresh`, `retry`; always available
  to the agent, so a session can be repaired from chat.
- **Host HTTP routes** under `/dsh-undermind/api/` for browser-side authorization and
  diagnostics.

## Requirements

1. **An Undermind account.** Each user authorizes with their own account; there is no API key or
   service-account mode.
2. **A client id.** Undermind does not support Dynamic Client Registration. It accepts either:

   - **CIMD** — an HTTPS URL serving a Client ID Metadata Document (JSON), which Undermind
     fetches; or
   - a **pre-registered client id**, requested from
     [`support@undermind.ai`](mailto:support@undermind.ai).

   CIMD is the self-service path. Host this document at any HTTPS URL you control, then put that
   URL in `clientId`:

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

   The URL must serve `application/json`. GitHub's `raw.githubusercontent.com` serves
   `text/plain`, so a Gist needs a JSON-serving mirror (a `gist.githack.com` raw URL works);
   GitHub Pages works as-is. `client_id` must be byte-identical to the URL, and `redirect_uris`
   must contain the plugin's `redirectUri` — update both together if you move the document.

   `GET /dsh-undermind/api/client-metadata` prints the template with the current `redirectUri`.

## Install

```sh
dsh plugin --profile web add github:VANuVANuu/dsh-plugin-undermind
```

Replace `web` with your profile name. The package is plain ESM with no build step, and declares
`@deepseek-ai/cordis` / `@deepseek-ai/schemastery` as peer dependencies so it shares the host's
copies instead of bundling its own.

Profiles owned by the desktop client are special: `desktop` is reserved by Electron, and the
`dsh plugin` CLI declines it. There, install from the plugin market, or place the package under
`profiles/desktop/node_modules` and add `dsh-plugin-undermind` to `dsh.profile.bundles`.

Do **not** also add `@deepseek-ai/dsh-mcp-client` for this server — it cannot refresh tokens,
and its tool names would collide with this plugin's.

## Configure

Every field is read live; saving in the plugin settings applies on the next call, no restart.

| Field | Default | Purpose |
|---|---|---|
| `clientId` | *(empty)* | **Required.** The CIMD HTTPS URL, or a pre-registered client id. |
| `mcpUrl` | `https://mcp.undermind.ai/mcp` | MCP endpoint; also sent as the OAuth `resource`. |
| `scope` | `mcp` | Requested scope. |
| `redirectUri` | `http://127.0.0.1:8799/callback` | Loopback callback; must be registered in the client document. |
| `authorizeEndpoint` | `https://api.undermind.ai/o/authorize/` | Authorization endpoint. |
| `tokenEndpoint` | `https://api.undermind.ai/o/token/` | Token endpoint. |
| `revocationEndpoint` | `https://api.undermind.ai/o/revoke_token/` | Revocation endpoint, called on logout. |
| `tokenFile` | *(empty)* | Empty means `$DSH_HOME/storages/undermind-mcp-auth.json`. |
| `requestTimeoutMs` | `30000` | Per-request MCP timeout. |
| `toolTimeoutMs` | `180000` | Per tool call; deep searches and PDF reading are slow. |
| `loginTimeoutMs` | `600000` | How long to wait for the browser round trip. |
| `toolPrefix` | `mcp__undermind__` | Prefix for the registered tool names. |
| `disabledTools` | `[]` | Raw Undermind tool names to hide, e.g. `["write_file"]`. |

## Use

### First login

Ask the agent to connect Undermind, or call the tool yourself:

```
undermind_auth action="login"
```

The plugin starts a one-shot server on the `redirectUri` port, builds the authorization URL
with `state` and PKCE, and opens it in the default browser. After you approve, the browser lands
on `127.0.0.1:8799/callback`; the plugin exchanges the code, writes the token, then lists and
registers the tools. `mcp__undermind__*` becomes visible to the model immediately —
`undermind_auth action="status"` reports `toolCount` and the registered names.

### Day to day

- "Search the literature on magnesium battery electrolytes since 2024" →
  `mcp__undermind__launch_deep_search` launches an asynchronous deep search (several minutes);
  poll it with `inspect_deep_searches`.
- "Find papers similar to this abstract" → `mcp__undermind__search_papers`.
- "Read these PDFs and tell me what methods they used" → `mcp__undermind__read_pdfs` sends one
  sub-agent per paper over the full text, figures included.
- "Put these papers in a new folder" → `create_folder` / `add_papers_to_folder`.

Three tools — `display_deep_search_results`, `display_references`, `suggest_pdf_uploads` — are
interactive cards in agents that support MCP Apps. In dsh they return text and links only.

### Troubleshooting

| Symptom | Fix |
|---|---|
| `missing_client_id` | Set `clientId`; see the CIMD document above. |
| Authorized but no tools | `undermind_auth action="retry"`, then read `lastError`. |
| `port_in_use` | Something holds 8799 — free it, or change `redirectUri` and the client document together. |
| `401` / `not_authorized` | The grant was revoked or is beyond refresh: `undermind_auth action="login"`. |
| Changed `clientId` | A token issued for the old client is not reused; log in again. |

### HTTP routes

Loopback only: the `Host` header must be `localhost` / `127.0.0.1` / `[::1]`, and requests
carrying `sec-fetch-site: cross-site` are refused.

| Route | Purpose |
|---|---|
| `GET /dsh-undermind/api/status` | Authorization state, token lifetime, tool count, last error. |
| `GET\|POST /dsh-undermind/api/tools` | Re-list and re-register tools. |
| `POST /dsh-undermind/api/login` | Start authorization; returns the `authorizeUrl`. |
| `POST /dsh-undermind/api/logout` | Revoke and delete the local token. |
| `GET /dsh-undermind/api/client-metadata` | CIMD template with the current `redirectUri`. |

Envelope: `{"ok":true,"data":…}` or `{"ok":false,"error":{"code","message"}}`.

## Security

- Tokens never leave the machine: they are written under `$DSH_HOME/storages/` with mode `0600`
  and an atomic replace.
- The token is sent only to `api.undermind.ai` and `mcp.undermind.ai`.
- The callback server binds loopback, accepts a single authorization code, then closes.
- You can revoke the connection at any time in your Undermind account settings.

## Layout

```
lib/index.js    plugin entry: Config, apply, login orchestration, auth tool, routes
lib/settings.js live settings (volatile readers)
lib/store.js    token file I/O, atomic and 0600
lib/auth.js     TokenManager: refresh, rotation, revocation, status
lib/oauth.js    PKCE, authorize URL, code exchange, callback server, browser
lib/mcp.js      MCP Streamable HTTP client (initialize, session, SSE, 401 recovery)
lib/bridge.js   MCP tools → dsh tools (generation swap, schema fallback)
lib/router.js   /dsh-undermind/api/* routes and the CIMD template
```
