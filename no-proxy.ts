/**
 * Qoder 官方域名免代理直连。
 *
 * 为什么必须有这个模块（2026-11-03 实测血证）：
 *
 * 本机终端开着 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY=http://127.0.0.1:7890`，
 * 而 pi 宿主在 `dist/core/http-dispatcher.js` 里用 `undici.EnvHttpProxyAgent`
 * 接管了全局 fetch —— 于是扩展里的每一次 `fetch()` 都真的走本地代理。
 *
 * 实测 `https://api3.qoder.sh/algo/api/v2/model/list`（Qoder 国际版模型目录）：
 *   - 走 127.0.0.1:7890 → **固定 10.005s 后连接失败**（代理节点不回 CONNECT）
 *   - 直连           → 0.16~0.75s（403 但通道畅通）
 *
 * 而 pi 在启动路径上会为每个已注册 provider 调一次 `refreshModels`，
 * 于是这一条域名就能把 `pi` 的启动拖到 **10~11 秒**（实测 5 次：10.05/0.32/10.05/10.33/0.38）。
 *
 * 修法就是 pi-workbuddy 里已验证过的那一条：把这些域名塞进 `NO_PROXY`。
 * 实测注入后同样 5 次：0.41/0.30/2.61/0.30 —— 10 秒级抖动消失，只剩跨境直连的正常波动。
 *
 * 副作用边界：只追加 Qoder 相关域名，绝不覆盖已有 NO_PROXY 条目，
 * 因此 GitHub / OpenAI / Claude 等业务继续走代理，不受影响。
 */

/** Qoder 国内版与国际版用到的全部域名（见 vendor/host/credentials.ts 的 REGIONS） */
export const QODER_DIRECT_DOMAINS = [
  "qoder.sh",
  "*.qoder.sh",
  "qoder.com",
  "*.qoder.com",
  "qoder.cn",
  "*.qoder.cn",
  "qoder.com.cn",
  "*.qoder.com.cn",
];

/**
 * 确保 Qoder 域名免代理直连（幂等）。
 *
 * 大小写两种变量名都要写：undici 与 curl 系工具读 `NO_PROXY`，
 * 而部分 Node 生态读 `no_proxy`，只设一个会漏。
 */
export function ensureQoderNoProxy(): void {
  const current = process.env.NO_PROXY || process.env.no_proxy || "";
  const missing = QODER_DIRECT_DOMAINS.filter((d) => !current.includes(d));
  if (missing.length === 0) return;
  const updated = current ? `${current},${missing.join(",")}` : missing.join(",");
  process.env.NO_PROXY = updated;
  process.env.no_proxy = updated;
}

// 模块被 import 的瞬间就生效——必须早于任何一次 fetch，
// 所以 index.ts 把它放在所有 import 的第一位。
ensureQoderNoProxy();
