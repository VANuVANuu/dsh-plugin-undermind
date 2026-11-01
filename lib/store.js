/**
 * 令牌持久化：`$DSH_HOME/storages/undermind-mcp-auth.json`。
 *
 * Undermind 的 access token 1 小时过期、refresh token 每次使用轮换，
 * 因此令牌必须落盘：进程重启后仍能续上，且轮换后的新 refresh token
 * 要立刻覆盖旧值（旧值一旦被用过即失效）。
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export function resolveTokenFile(settings) {
  if (typeof settings.tokenFile === 'string' && settings.tokenFile.length > 0) {
    return path.resolve(settings.tokenFile);
  }
  const home = process.env.DSH_HOME?.trim() || path.join(homedir(), '.dsh');
  return path.join(home, 'storages', 'undermind-mcp-auth.json');
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 读取令牌状态；文件不存在或损坏时返回 null（损坏不抛错，按未授权处理）。 */
export async function readTokenState(settings) {
  const file = resolveTokenFile(settings);
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    if (!isRecord(parsed)) return null;
    if (typeof parsed.accessToken !== 'string' || parsed.accessToken.length === 0) return null;
    return {
      accessToken: parsed.accessToken,
      refreshToken: typeof parsed.refreshToken === 'string' ? parsed.refreshToken : '',
      tokenType: typeof parsed.tokenType === 'string' ? parsed.tokenType : 'Bearer',
      scope: typeof parsed.scope === 'string' ? parsed.scope : '',
      expiresAt: Number.isFinite(parsed.expiresAt) ? parsed.expiresAt : 0,
      clientId: typeof parsed.clientId === 'string' ? parsed.clientId : '',
      resource: typeof parsed.resource === 'string' ? parsed.resource : '',
      tokenEndpoint: typeof parsed.tokenEndpoint === 'string' ? parsed.tokenEndpoint : '',
      obtainedAt: typeof parsed.obtainedAt === 'string' ? parsed.obtainedAt : '',
    };
  } catch {
    return null;
  }
}

/** 原子写入令牌状态（先写临时文件再 rename），权限收紧到 0600。 */
export async function writeTokenState(settings, state) {
  const file = resolveTokenFile(settings);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const payload = `${JSON.stringify(state, null, 2)}\n`;
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, file);
  return file;
}

/** 删除令牌文件（退出登录）。 */
export async function clearTokenState(settings) {
  const file = resolveTokenFile(settings);
  await rm(file, { force: true });
  return file;
}
