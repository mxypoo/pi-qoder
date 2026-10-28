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

interface RegionRuntime {
  id: string;
  displayName: string;
  /** 当前模型目录：启动期为静态兜底，惰性初始化后被 live 名册覆盖 */
  entries: CatalogEntry[];
  shim?: any;
  /** 幂等的惰性初始化句柄 */
  initialized?: Promise<void>;
}

export default async function (pi: ExtensionAPI) {
  const runtimes = new Map<string, RegionRuntime>();

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
      models: (piModels.length > 0 ? piModels : [
        // 兜底基础模型（未登录时展示）
        {
          id: `${regionId}-default`,
          name: `${displayName} (请先执行 /qoder-login 登录)`,
          api: "openai-completions",
          provider: regionId,
          baseUrl: `${baseUrl}/v1`,
          input: ["text"],
          reasoning: false,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 16384,
        },
      ]) as any,
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
        await ensureLoaded(regionId);
        return toPiModels(rt, rt.shim.baseUrl()) as any;
      },
    });
  };

  /**
   * 惰性初始化：首次真正使用该 provider 时才起 shim、读凭据、拉名册。
   *
   * 原先这三步全在启动路径上串行执行（每个 region 一次 await shim.ready
   * 加一次 fetchModels 网络请求），实测让每次启动多付约 0.6~1.0 秒。
   * 幂等且并发安全（共享同一个 Promise）。
   */
  const ensureLoaded = (regionId: string): Promise<void> => {
    const rt = runtimes.get(regionId)!;
    if (rt.initialized) return rt.initialized;

    rt.initialized = (async () => {
      const region = REGIONS.find((r) => r.id === regionId)!;

      // 1. 启动本地安全 Loopback Shim
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

      // 2. 拉取最新模型名册（失败则保留静态兜底）
      try {
        const cred = await getCredentialFor(region.id);
        if (cred) {
          const rawModels = await fetchModels(region, cred);
          rt.entries = (rawModels as any[]).map((m) => normalizeEntry(m, region));
        }
      } catch {
        // 离线或未登录时静默使用静态兜底名册
      }

      // 3. 用真实 shim 地址与真实名册重注册（registerProvider 支持运行时重注册并合并）
      registerProvider(rt);
    })().catch((err) => {
      // 初始化失败必须清空句柄，否则后续重试会永远拿到同一个 rejected Promise
      rt.initialized = undefined;
      throw err;
    });

    return rt.initialized;
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
      await ensureLoaded(regionId);
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
