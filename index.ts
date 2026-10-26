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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = path.join(__dirname, "vendor/dsh-connect-qoder");

export default async function (pi: ExtensionAPI) {
  // 维护各区域的模型目录缓存
  const catalogs = new Map<string, CatalogEntry[]>();

  // 1. 启动各区域的本地安全 Loopback Shim
  const shims = new Map<string, any>();

  for (const region of REGIONS) {
    const shim = createQoderShim({
      region,
      resolveCredential: () => getCredentialFor(region.id),
      resolveModels: () => catalogs.get(region.id) ?? [],
      resolveUpstreamKey: (modelId: string) => {
        const cat = catalogs.get(region.id) ?? [];
        const entry = cat.find((m) => m.id === modelId);
        return entry?.key;
      },
      resolveAlwaysThinking: (modelId: string) => {
        const cat = catalogs.get(region.id) ?? [];
        const entry = cat.find((m) => m.id === modelId);
        return entry?.alwaysThinking;
      },
    });

    await shim.ready;
    shims.set(region.id, shim);

    // 尝试拉取一次初始模型名册
    try {
      const cred = await getCredentialFor(region.id);
      if (cred) {
        const rawModels = await fetchModels(region, cred);
        const entries = (rawModels as any[]).map((m) => normalizeEntry(m, region));
        catalogs.set(region.id, entries);
      }
    } catch {
      // 启动时若尚未登录或无网络则静默忽略
    }

    // 将模型转为 Pi 模型格式（开启 preferMaximumContext，解锁 1M 上下文）
    const currentEntries = catalogs.get(region.id) ?? [];
    const piModels = currentEntries.map((e) =>
      toPiModel(e, `${shim.baseUrl()}/v1`, region.id, true)
    );

    // 2. 注册 Provider 给 Pi
    pi.registerProvider(region.id, {
      name: region.displayName,
      baseUrl: `${shim.baseUrl()}/v1`,
      apiKey: shim.token(),
      api: "openai-completions",
      models: (piModels.length > 0 ? piModels : [
        // 兜底基础模型（未登录时展示）
        {
          id: `${region.id}-default`,
          name: `${region.displayName} (请先执行 /qoder-login 登录)`,
          api: "openai-completions",
          provider: region.id,
          baseUrl: `${shim.baseUrl()}/v1`,
          input: ["text"],
          reasoning: false,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 16384,
        },
      ]) as any,
      oauth: {
        name: `${region.displayName} (浏览器授权)`,
        login: async (callbacks) => {
          const cred = await startDeviceLoginFlow(region.id, callbacks);
          // 登录成功后立即刷新并缓存模型名册
          try {
            const rawModels = await fetchModels(region, cred);
            const entries = (rawModels as any[]).map((m) => normalizeEntry(m, region));
            catalogs.set(region.id, entries);
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
          const refreshed = await refreshCredential(region.id);
          if (!refreshed) throw new Error(`无法刷新 ${region.displayName} 凭据，请重新登录`);
          return {
            access: refreshed.token,
            refresh: credentials.refresh,
            expires: Date.now() + 24 * 3600 * 1000,
          };
        },
        // 始终返回当前活动 Shim 的随机 Secret，确保本地 Loopback 通信 100% 鉴权通过
        getApiKey: () => shim.token(),
      },
      refreshModels: async () => {
        const cred = await getCredentialFor(region.id);
        if (!cred) return [];
        const rawModels = await fetchModels(region, cred);
        const entries = (rawModels as any[]).map((m) => normalizeEntry(m, region));
        catalogs.set(region.id, entries);
        return entries.map((e) =>
          toPiModel(e, `${shim.baseUrl()}/v1`, region.id, true)
        ) as any;
      },
    });
  }

  // 3. 注册退出清理钩子
  pi.on("session_shutdown", async () => {
    for (const shim of shims.values()) {
      try {
        await shim.close();
      } catch {}
    }
  });

  // 4. 注册命令：/qoder-login 登录
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
            catalogs.set(regionId, entries);
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

  // 5. 注册命令：/qoder-status 查看额度与状态
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

  // 6. 注册命令：/qoder-checkin 每日签到
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

  // 7. 注册命令：/qoder-update 一键更新协议
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
