import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { exec } from "node:child_process";

// 引用 vendor 中的设备登录与凭据逻辑
import {
  createDeviceSession,
  buildAuthUrl,
  pollOnce,
  refreshOnce,
  productForRegion,
  type DeviceTokenPayload,
  type DeviceSession,
} from "./vendor/dsh-connect-qoder/src/host/device-login.ts";
import {
  loadEnvCredential,
  REGIONS,
} from "./vendor/dsh-connect-qoder/src/host/credentials.ts";
import type { Region, QoderCredential } from "./vendor/dsh-connect-qoder/src/host/domain.ts";

const AUTH_FILE = join(homedir(), ".pi", "agent", "qoder-auth.json");
const PI_AUTH_FILE = join(homedir(), ".pi", "agent", "auth.json");

interface StoredAuthData {
  [regionId: string]: DeviceTokenPayload & { machineID?: string };
}

/** 读取 Pi 原生 auth.json */
export function readPiAuthFile(): Record<string, any> {
  try {
    if (!existsSync(PI_AUTH_FILE)) return {};
    return JSON.parse(readFileSync(PI_AUTH_FILE, "utf8"));
  } catch {
    return {};
  }
}

/** 读取本地保存的所有 Qoder 凭据 */
export function readAuthFile(): StoredAuthData {
  try {
    if (!existsSync(AUTH_FILE)) return {};
    const text = readFileSync(AUTH_FILE, "utf8");
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** 保存凭据到本地文件，权限 0600 */
export function saveAuthFile(data: StoredAuthData): void {
  try {
    mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
    writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error("[pi-qoder] 保存凭据失败:", err);
  }
}

/** 跨平台打开默认浏览器 */
export function openBrowser(url: string): void {
  const platform = process.platform;
  if (platform === "darwin") {
    exec(`open "${url}"`);
  } else if (platform === "win32") {
    exec(`start "" "${url}"`);
  } else {
    exec(`xdg-open "${url}"`);
  }
}

/**
 * 获取某个 region 的有效凭据（优先 Pi auth.json，次选 qoder-auth.json，再选环境变量 PAT，过期自动刷新）
 */
export async function getCredentialFor(regionId: string): Promise<QoderCredential | undefined> {
  // 1. 优先读取 Pi 原生 auth.json（用户执行 /login 保存的位置）
  const piAuth = readPiAuthFile();
  const piEntry = piAuth[regionId];
  if (piEntry && (piEntry.access || piEntry.token)) {
    const token = piEntry.access || piEntry.token;
    return {
      userID: piEntry.userID || "",
      token,
      name: piEntry.name || "",
      email: piEntry.email || "",
      machineID: piEntry.machineID || "",
    };
  }

  // 2. 如果有本地存储的设备凭据 (qoder-auth.json)
  const authData = readAuthFile();
  const entry = authData[regionId];

  if (entry && entry.token) {
    const now = Date.now();
    // 检查是否临近过期（提前 5 分钟刷新）
    const isExpired = entry.expiresAt > 0 && entry.expiresAt - now < 5 * 60 * 1000;
    if (isExpired && entry.refreshToken) {
      const refreshed = await refreshCredential(regionId);
      if (refreshed) return refreshed;
    }

    return {
      userID: entry.userID,
      token: entry.token,
      name: entry.name,
      email: entry.email,
      machineID: entry.machineID,
    };
  }

  // 3. 检查环境变量 PAT (QODERCN_PAT / QODER_PAT)
  const region = REGIONS.find((r: Region) => r.id === regionId);
  if (region) {
    try {
      const envCred = await loadEnvCredential(region);
      if (envCred && envCred.token) {
        return {
          userID: envCred.userID,
          token: envCred.token,
          name: envCred.name,
          email: envCred.email,
          machineID: envCred.machineID,
        };
      }
    } catch {
      // 忽略 PAT 失败
    }
  }

  return undefined;
}

/** 刷新凭据 */
export async function refreshCredential(regionId: string): Promise<QoderCredential | undefined> {
  const product = productForRegion(regionId);
  if (!product) return undefined;

  const authData = readAuthFile();
  const current = authData[regionId];
  if (!current || !current.refreshToken) return undefined;

  try {
    const outcome = await refreshOnce(product, current);
    if (outcome.kind === "refreshed") {
      authData[regionId] = {
        ...outcome.payload,
        machineID: current.machineID,
      };
      saveAuthFile(authData);
      return {
        userID: outcome.payload.userID,
        token: outcome.payload.token,
        name: outcome.payload.name,
        email: outcome.payload.email,
        machineID: current.machineID,
      };
    }
  } catch (err) {
    console.error(`[pi-qoder] 刷新 ${regionId} 令牌失败:`, err);
  }
  return undefined;
}

/**
 * 执行设备授权流程（打开浏览器，轮询等待授权）
 */
export async function startDeviceLoginFlow(
  regionId: string,
  callbacks?: {
    onAuth?: (info: { url: string; instructions?: string }) => void;
    onProgress?: (msg: string) => void;
    signal?: AbortSignal;
  }
): Promise<DeviceTokenPayload> {
  const product = productForRegion(regionId);
  if (!product) {
    throw new Error(`未知的 Qoder 区域: ${regionId}`);
  }

  const session: DeviceSession = createDeviceSession(regionId);
  const authUrl = buildAuthUrl(product, session);

  // 告知调用方并拉起系统默认浏览器
  if (callbacks?.onAuth) {
    callbacks.onAuth({
      url: authUrl,
      instructions: `请在浏览器中登录并授权 Qoder (${regionId}) 访问权限`,
    });
  }
  openBrowser(authUrl);

  const startTime = Date.now();
  const timeoutMs = 300_000; // 5 分钟超时

  while (Date.now() - startTime < timeoutMs) {
    if (callbacks?.signal?.aborted) {
      throw new Error("用户取消了授权流程");
    }

    const outcome = await pollOnce(product, session, callbacks?.signal);

    if (outcome.kind === "authorized") {
      const payload = outcome.payload;
      const allAuth = readAuthFile();
      allAuth[regionId] = {
        ...payload,
        machineID: session.machineID,
      };
      saveAuthFile(allAuth);
      return payload;
    }

    if (outcome.kind === "failed") {
      throw new Error(`授权轮询失败: ${outcome.name}`);
    }

    // 等待 2 秒后继续下一次轮询
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error("等待授权超时（5分钟），请重试");
}
