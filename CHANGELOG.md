# 更新日志 (Changelog)

所有针对 `pi-qoder` 插件的实质性变更都会记录在本文档中。

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
