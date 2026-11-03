// ⚠ 必须是第一条 import：模块顶层就把 Qoder 域名写进 NO_PROXY，
// 早于下面所有 vendor 模块与任何一次 fetch（详见 no-proxy.ts 里的实测数据）。
import "./no-proxy.ts";

import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 引用 vendor 模块（通过 Git Submodule 挂载的官方上游实现）
import { createQoderShim } from "./vendor/dsh-connect-qoder/src/host/shim.ts";
import { REGIONS } from "./vendor/dsh-connect-qoder/src/host/credentials.ts";
import { fetchModels, fetchUsage, claimCampaign } from "./vendor/dsh-connect-qoder/src/host/upstream.ts";
import { normalizeEntry } from "./vendor/dsh-connect-qoder/src/host/catalog-entry.ts";
import { toPiModel } from "./vendor/dsh-connect-qoder/src/host/pi-model.ts";
import type { CatalogEntry } from "./vendor/dsh-connect-qoder/src/host/domain.ts";

// 引用本地 auth 模块
import {
  getCredentialFor,
  startDeviceLoginFlow,
  refreshCredential,
  readAuthFile,
  readPiAuthFile,
} from "./auth.ts";

// 启动期静态兜底名册（纯数据，避免启动路径上的网络请求）
import { fallbackEntriesFor } from "./fallback-models.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = path.join(__dirname, "vendor/dsh-connect-qoder");

/**
 * 启动期惰性拉取模型目录的超时上限。
 *
 * 这个值直接决定「网络很差时 pi 启动最多被拖多久」，所以取得很短：
 * 正常的模型目录响应在 100~700ms，1.2s 已经覆盖近 2 倍余量；超时也不影响可用性，
 * 名册会退回 fallback-models.ts 里的静态兜底（模型可正常选择与调用）。
 *
 * 实测（本机、跨境直连、6 次采样）：正常 0.10~0.70s，劣化 2.5s → 1.2s 后最差不过 1.3s。
 */
const CATALOG_FETCH_TIMEOUT_MS = 1_200;

interface RegionRuntime {
  id: string;
  displayName: string;
  /** 当前模型目录：启动期为静态兜底，后台刷新后被 live 名册覆盖 */
  entries: CatalogEntry[];
  shim?: any;
  /** 幂等的本地初始化句柄（起 shim，零网络） */
  initialized?: Promise<void>;
  /** 后台名册刷新的单飞句柄 */
  refreshing?: Promise<void>;
}

export default async function (pi: ExtensionAPI) {
  const runtimes = new Map<string, RegionRuntime>();

  /** 未登录/国际版无静态名册时的占位模型（保证 provider 不会从选择器里凭空消失） */
  const placeholderModel = (rt: RegionRuntime, baseUrl: string) => ({
    id: `${rt.id}-default`,
    name: `${rt.displayName} (请先执行 /qoder-login 登录)`,
    api: "openai-completions" as const,
    provider: rt.id,
    baseUrl: `${baseUrl}/v1`,
    input: ["text"] as ("text" | "image")[],
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  });

  /** 把 CatalogEntry 映射为 Pi 模型定义 */
  const toPiModels = (rt: RegionRuntime, baseUrl: string) => {
    return rt.entries.map((e) => toPiModel(e, `${baseUrl}/v1`, rt.id, true));
  };

  /** 向 Pi 注册（或重注册）一个 region 的 provider */
  const registerProvider = (rt: RegionRuntime) => {
    const { id: regionId, displayName } = rt;
    const shim = rt.shim;
    // shim 未就绪时用占位 baseUrl，惰性初始化完成后会重注册覆盖
    const baseUrl = shim ? shim.baseUrl() : "http://127.0.0.1:0";
    const piModels = toPiModels(rt, baseUrl);

    pi.registerProvider(regionId, {
      name: displayName,
      baseUrl: `${baseUrl}/v1`,
      apiKey: shim ? shim.token() : "pending-init",
      api: "openai-completions",
      models: (piModels.length > 0 ? piModels : [placeholderModel(rt, baseUrl)]) as any,
      oauth: {
        name: `${displayName} (浏览器授权)`,
        login: async (callbacks) => {
          const cred = await startDeviceLoginFlow(regionId, callbacks);
          // 登录成功后立即刷新并缓存模型名册
          try {
            const region = REGIONS.find((r) => r.id === regionId)!;
            const rawModels = await fetchModels(region, cred);
            rt.entries = (rawModels as any[]).map((m) => normalizeEntry(m, region));
          } catch {}
          return {
            access: cred.token,
            refresh: cred.refreshToken,
            expires: cred.expiresAt,
            userID: cred.userID,
            name: cred.name,
            email: cred.email,
            machineID: (cred as any).machineID,
          };
        },
        refreshToken: async (credentials) => {
          const refreshed = await refreshCredential(regionId);
          if (!refreshed) throw new Error(`无法刷新 ${displayName} 凭据，请重新登录`);
          return {
            access: refreshed.token,
            refresh: credentials.refresh,
            expires: Date.now() + 24 * 3600 * 1000,
          };
        },
        // 始终返回当前活动 Shim 的随机 Secret，确保本地 Loopback 通信 100% 鉴权通过
        getApiKey: () => (rt.shim ? rt.shim.token() : "pending-init"),
      },
      // Pi 只在用户打开模型选择器时调用 refreshModels，不在启动时调用。
      // 因此它既是「选择器能看到最新名册」的挂载点，也是天然的惰性触发点。
      refreshModels: async () => {
        // 只等本地 shim（毫秒级），名册刷新丢到后台：
        // 启动路径上一个网络请求都不等（详见 refreshCatalog 的注释）。
        await ensureLocal(regionId);
        void refreshCatalog(regionId);
        const baseUrl = rt.shim.baseUrl();
        const models = toPiModels(rt, baseUrl);
        // 空列表会让 pi 把这个 provider 从选择器里整行拿掉（国际版没有静态名册），
        // 所以永不让它为空：至少留一个指向登录提示的占位行。
        return (models.length > 0 ? models : [placeholderModel(rt, baseUrl)]) as any;
      },
    });
  };

  /**
   * 本地初始化：只起 shim，**零网络**。幂等且并发安全。
   *
   * 凭据不需要在这里取：shim 的 `resolveCredential` 是惰回调，
   * 真正发请求时才去拿（并顺带完成可能需要的令牌刷新）。
   */
  const ensureLocal = (regionId: string): Promise<void> => {
    const rt = runtimes.get(regionId)!;
    if (rt.initialized) return rt.initialized;

    rt.initialized = (async () => {
      const region = REGIONS.find((r) => r.id === regionId)!;
      const shim = createQoderShim({
        region,
        resolveCredential: () => getCredentialFor(region.id),
        resolveModels: () => rt.entries,
        resolveUpstreamKey: (modelId: string) => {
          return rt.entries.find((m) => m.id === modelId)?.key;
        },
        resolveAlwaysThinking: (modelId: string) => {
          return rt.entries.find((m) => m.id === modelId)?.alwaysThinking;
        },
      });
      await shim.ready;
      rt.shim = shim;
      registerProvider(rt);
    })().catch((err) => {
      // 初始化失败必须清空句柄，否则后续重试会永远拿到同一个 rejected Promise
      rt.initialized = undefined;
      throw err;
    });

    return rt.initialized;
  };

  /**
   * 后台刷新模型名册（带短超时），**绝不阻塞启动**。
   *
   * 为什么必须放到后台：pi 启动期会为每个已注册 provider 调一次 `refreshModels`，
   * 而这是一个真实的跨境网络请求。本机实测（2026-11-03）：
   *   - 走本地代理 `127.0.0.1:7890` → 固定 10.005s 后失败
   *   - 直连（no-proxy.ts 注入后）→ 0.10~0.70s，恶劣时超 1.2s
   * 即便有 1.2s 超时兜底，串行两个 region 仍会让启动多付 ~1.5s。
   * 而名册只是「给选择器看的目录」，晚一拍没有任何功能代价：
   * fallback-models.ts 里的静态名册已经能正常选模型、正常发请求。
   *
   * 单飞：同一个 region 的并发触发共享同一个 Promise，不重复打上游。
   */
  const refreshCatalog = (regionId: string): Promise<void> => {
    const rt = runtimes.get(regionId)!;
    if (rt.refreshing) return rt.refreshing;

    const region = REGIONS.find((r) => r.id === regionId)!;
    rt.refreshing = (async () => {
      try {
        const cred = await getCredentialFor(region.id);
        if (!cred) return; // 未登录：名册留静态兜底
        const rawModels = await fetchModels(region, cred, AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS));
        const entries = (rawModels as any[]).map((m) => normalizeEntry(m, region));
        if (entries.length === 0) return; // 空名册不得覆盖可用名册
        rt.entries = entries;
        await ensureLocal(regionId);
        registerProvider(rt);
      } catch {
        // 离线 / 超时 / 未登录：静默保留静态兜底名册，不留任何半成品状态
      } finally {
        rt.refreshing = undefined;
      }
    })();

    return rt.refreshing;
  };

  // ── 启动路径：只用静态兜底名册注册，零网络请求 ──
  for (const region of REGIONS) {
    const rt: RegionRuntime = {
      id: region.id,
      displayName: region.displayName,
      entries: [...fallbackEntriesFor(region.id)],
    };
    runtimes.set(region.id, rt);
    registerProvider(rt);
  }

  // ── 退出清理钩子 ──
  pi.on("session_shutdown", async () => {
    for (const rt of runtimes.values()) {
      try {
        await rt.shim?.close();
      } catch {}
    }
  });

  /**
   * 发请求前的最后安全点：若当前模型属于本插件，则必须在请求真正发出前完成 shim 初始化。
   *
   * 这是惰性加载方案完整性的关键——用户可以提前把 qoder 模型设为默认模型，
   * 此时启动期不会打开模型选择器，`refreshModels` 也不会被调用，
   * 若没有这个钩子，首次请求就会打到占位 baseUrl 而失败。
   */
  pi.on("before_agent_start", async (_event, ctx) => {
    const regionId = ctx.model?.provider;
    if (!regionId || !runtimes.has(regionId)) return;
    if (runtimes.get(regionId)!.shim) return; // 已就绪
    try {
      // 只需本地 shim 就位就能发请求；名册刷新丢后台，不拖首轮响应
      await ensureLocal(regionId);
      void refreshCatalog(regionId);
    } catch {
      // 初始化失败时静默放行，让请求自然报错并保留重试机会
    }
  });

  // ── 命令：/qoder-login 登录 ──
  pi.registerCommand("qoder-login", {
    description: "登录 Qoder (默认国内版 qoder-cn，也可指定国际版 qoder)",
    handler: async (args, ctx) => {
      const regionId = (args?.trim() === "qoder" ? "qoder" : "qoder-cn");
      const regionName = regionId === "qoder-cn" ? "Qoder CN (国内版)" : "Qoder (国际版)";
      ctx.ui.notify(`正在启动 ${regionName} 浏览器授权流程...`, "info");

      try {
        const payload = await startDeviceLoginFlow(regionId, {
          onAuth: ({ url, instructions }) => {
            ctx.ui.notify(`${instructions}\n授权网址: ${url}`, "info");
          },
        });

        const region = REGIONS.find((r) => r.id === regionId);
        if (region) {
          try {
            const rawModels = await fetchModels(region, payload);
            const entries = (rawModels as any[]).map((m) => normalizeEntry(m, region));
            const rt = runtimes.get(regionId);
            if (rt) rt.entries = entries;
            ctx.ui.notify(`✅ 登录成功！用户: ${payload.name || payload.userID}，已加载 ${entries.length} 个模型`, "info");
          } catch (e: any) {
            ctx.ui.notify(`✅ 登录成功，但刷新模型失败: ${e.message}`, "warning");
          }
        }
      } catch (err: any) {
        ctx.ui.notify(`❌ 登录失败: ${err.message}`, "error");
      }
    },
  });

  // ── 命令：/qoder-status 查看额度与状态 ──
  pi.registerCommand("qoder-status", {
    description: "查看当前 Qoder 账号用量与额度状态",
    handler: async (_args, ctx) => {
      const allAuth = { ...readAuthFile(), ...readPiAuthFile() };
      const lines: string[] = ["=== Qoder 状态面板 ==="];

      for (const region of REGIONS) {
        const cred = allAuth[region.id];
        if (!cred) {
          lines.push(`\n[${region.displayName}]: 未登录 (可执行 /qoder-login ${region.id})`);
          continue;
        }

        lines.push(`\n[${region.displayName}]: 已登录`);
        lines.push(`  用户: ${cred.name || cred.userID} (${cred.email || "无邮箱"})`);
        if (cred.expiresAt || cred.expires) {
          const exp = cred.expiresAt || cred.expires;
          lines.push(`  到期时间: ${new Date(exp).toLocaleString()}`);
        }

        try {
          const usage = await fetchUsage(region, cred);
          lines.push(`  当前用量: ${JSON.stringify(usage)}`);
        } catch {
          lines.push(`  用量查询: 暂时无法连接上游`);
        }
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ── 命令：/qoder-checkin 每日签到 ──
  pi.registerCommand("qoder-checkin", {
    description: "执行 Qoder 每日签到领取免费积分",
    handler: async (_args, ctx) => {
      ctx.ui.notify("正在检查 Qoder CN 今日签到状态...", "info");
      const region = REGIONS.find((r) => r.id === "qoder-cn")!;
      const cred = await getCredentialFor("qoder-cn");

      if (!cred) {
        ctx.ui.notify("请先执行 /qoder-login 登录国内版后再签到", "warning");
        return;
      }

      try {
        const result = await claimCampaign(region, cred, "daily_checkin");
        ctx.ui.notify(`🎉 签到结果: ${JSON.stringify(result)}`, "info");
      } catch (err: any) {
        ctx.ui.notify(`签到提示: ${err.message}`, "info");
      }
    },
  });

  // ── 命令：/qoder-update 一键更新协议 ──
  pi.registerCommand("qoder-update", {
    description: "一键更新 Qoder 核心协议至 GitHub 最新版",
    handler: async (_args, ctx) => {
      ctx.ui.notify("正在拉取上游 dsh-connect-qoder 最新协议更新...", "info");
      try {
        const pullOutput = execSync("git pull origin main", { cwd: VENDOR_DIR }).toString().trim();
        const latestCommit = execSync("git log -1 --pretty=format:'%h - %s (%cr)'", { cwd: VENDOR_DIR }).toString().trim();
        ctx.ui.notify(`✅ 更新完成！\n${pullOutput}\n当前核心版本: ${latestCommit}`, "info");
      } catch (err: any) {
        ctx.ui.notify(`❌ 更新失败: ${err.message}`, "error");
      }
    },
  });
}
