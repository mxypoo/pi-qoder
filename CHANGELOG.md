# 更新日志 (Changelog)

所有针对 `pi-qoder` 插件的实质性变更都会记录在本文档中。

---

## [1.2.0] - 2026-11-03

### 修复 (Fixed) — 启动被拖慢 10 秒

- **根因：Qoder 国际版请求走了本地代理，且它被压在启动路径上。**
  - 本机终端开着 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY=http://127.0.0.1:7890`，而 pi 宿主用 `undici.EnvHttpProxyAgent`（`dist/core/http-dispatcher.js`）接管了全局 `fetch`，所以扩展里的每个 `fetch()` 都真的走代理。
  - 实测 `https://api3.qoder.sh/algo/api/v2/model/list`（国际版模型目录）：走代理 **固定 10.005s 后连接失败**；直连 0.10~0.70s。
  - 而 pi 启动期会为每个已注册 provider 调一次 `refreshModels`，于是这一条域名就能把启动拖到 10~11 秒。修复前实测「仅加载本插件」5 次：`10.05 / 0.32 / 10.05 / 10.33 / 0.38`。

### 新增 (Added)

- **`no-proxy.ts`：Qoder 官方域名免代理直连。**
  - 模块顶层（`index.ts` 第一条 import）就把 `qoder.sh / qoder.com / qoder.cn / qoder.com.cn` 及其通配子域追加进 `NO_PROXY` 与 `no_proxy`，早于任何一次 `fetch`。
  - 只追加、不覆盖：GitHub / OpenAI / Claude 等业务继续走代理，零副作用。

### 变更 (Changed)

- **网络刷新彻底移出启动等待路径。** 原先 `ensureLoaded` 把「起 shim + 读凭据 + 拉名册」三步串在一起，`refreshModels` 必须等完整条网络链路。现拆为：
  - `ensureLocal()`：只起本地 shim 与注册 provider，**零网络**（凭据由 shim 的惰性回调在真正发请求时再取）；
  - `refreshCatalog()`：后台单飞刷新名册，带 `AbortSignal.timeout(1200)`，完成后重注册 provider。超时/离线/未登录一律静默保留静态兜底名册，不留半成品状态。
  - 名册只是「给选择器看的目录」，晚一拍零功能代价：`fallback-models.ts` 的静态名册已能正常选模型、发请求。
- `refreshModels` 永不再返回空数组：国际版没有静态名册时返回占位行，避免 pi 把整个 provider 从选择器里拿掉。

### 实测 (Measured)

- 仅加载本插件，TUI 启动（`PI_STARTUP_BENCHMARK=1`）8 次：`0.51 / 0.32 / 0.30 / 0.30 / 0.30 / 0.30 / 0.30 / 0.30` 秒。
- `refreshModels` 回归为纯本地：`qoder-cn` 15ms、`qoder` 1ms（原为 10s 超时）。
- pi 全量启动（含 3 个本地扩展 + 3 个 npm 包）从 **9~11s 降到 0.84~0.88s**。

---

## [1.1.0] - 2026-10-28

### 性能 (Performance)

- **启动零阻塞**：将「起 shim + 读凭据 + 拉模型名册」从启动路径移出，改为首次真正使用该 provider 时才执行。
  - 原先启动时对两个 region 依次执行 `await shim.ready` 与 `fetchModels()` 网络请求（实测 qoder-cn 的 `fetchModels` 约 500ms，国际版凭据过期时还要多等一次 403），合计给每次启动增加 0.6~1.0 秒。
  - 现在启动路径只用 `fallback-models.ts` 里的纯数据静态名册注册 provider，零网络请求。
  - 实测：单独加载本插件 `--list-models` 中位数从 **1.07s 降至 0.68s**，真实会话从启动到可用明显加快。

### 新增 (Added)

- `fallback-models.ts`：启动期静态兜底名册（纯数据、零依赖），采集自 qoder-cn 上游真实名册（10 个模型）。
  - 存的是 vendor 的 `CatalogEntry` 原始形态而非 `toPiModel` 的输出，这样 `toPiModel` 的推导逻辑（`thinkingLevelMap`、错峰价标签 `displayNameFor`、`resolveContextWindow`）依然由 vendor 唯一实现，不会出现两份漂移的映射。
  - 国际版 `qoder` 凭据采集时已过期，故其兜底名册为空，注册兜底占位模型（提示先登录）。

### 变更 (Changed)

- `refreshModels` 改为惰性挂载点：Pi 只在用户打开模型选择器时调用它，因此启动零开销，而选择器内依然能看到最新名册。
- 新增 `before_agent_start` 钩子：覆盖「用户把 qoder 模型设为默认模型后直接发消息」的场景，确保请求发出前 shim 已就绪。没有这个钩子，首次请求会打到占位 `baseUrl` 而失败。
- `ensureLoaded()` 在初始化失败时清空句柄，允许后续重试（避免 rejected Promise 被永久缓存）。
- 登录命令与 `refreshModels` 统一写回 `runtimes` 的 `entries`，不再各自维护一份 catalog Map。

---
