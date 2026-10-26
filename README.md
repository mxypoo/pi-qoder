<h1 align="center">pi-qoder</h1>

<p align="center"><b>把本地已登录的 Qoder / Qoder CN 模型接入 Pi Coding Agent，零配置用你的账号额度与免费模型。</b></p>

<p align="center">
  <a href="#特性">特性</a> ·
  <a href="#工作原理">工作原理</a> ·
  <a href="#安装方式">安装方式</a> ·
  <a href="#常用命令">常用命令</a> ·
  <a href="#版本维护与一键更新">版本维护与一键更新</a> ·
  <a href="#开源许可与致谢">致谢</a>
</p>

---

## 特性

- ⚡ **零配置双区域接入**：支持国内版 **Qoder CN** (`qoder-cn`) 与国际版 **Qoder** (`qoder`) 独立并存；
- 🔑 **跨平台免密扫码/浏览器授权**：基于 RFC 7636 PKCE S256 流程，macOS、Linux、Windows 一键拉起系统浏览器授权，自动换取并持久化 Token，静默自动续签；
- 🛡️ **安全 Loopback 桥接**：启动时随 Pi 动态监听本地私有端口（`127.0.0.1:随机端口` + 进程内随机 Bearer Token），仅限本机进程调用，Pi 退出时优雅释放端口，不留常驻僵尸进程；
- 🔄 **标准协议转换**：透明代理 OpenAI Completions 请求，生成合规的 COSY 签名、进行置换 Base64 编码，实时将 Qoder 双层信封 SSE 转换为标准的流式响应（含思考过程与工具调用）；
- 📦 **上游零冲突挂载**：通过 Git Submodule 挂载上游协议真源，原作者发布协议补丁时可一键无损同步，避免代码分叉维护。

---

## 工作原理

```text
Pi Coding Agent (pi)
   │
   │ (标准 OpenAI Completions SSE)
   ▼
pi-qoder Loopback Shim (127.0.0.1:随机端口)
   │
   ├─► 1. 动态生成 AES-CBC 密钥并用 Qoder RSA 公钥包裹
   ├─► 2. 构造 Cosy-* 鉴权头与 Authorization: Bearer COSY.<payload>.<sig>
   ├─► 3. 请求体 Base64 字母表置换 + 1/3 位置旋转 (Encode=1)
   │
   ▼
Qoder 网关 (国内 gateway.qoder.com.cn / 国际 api3.qoder.sh)
   │
   ▼ (Qoder 双层信封 SSE: data: {"body": "{\"choices\":[...]}"})
pi-qoder SSE 解包器
   │
   ▼ (标准 OpenAI delta chunk + reasoning_content)
Pi 终端界面渲染
```

---

## 安装方式

### 方式 1：直接克隆到 Pi 扩展目录（推荐）

```bash
# 1. 克隆本仓库（含上游协议子模块）
git clone --recurse-submodules https://github.com/mxypoo/pi-qoder.git ~/.pi/agent/extensions/pi-qoder

# 2. 建立 Pi 自动加载软链接
ln -sf ~/.pi/agent/extensions/pi-qoder/index.ts ~/.pi/agent/extensions/qoder.ts
```

### 方式 2：真源存放在 Documents，运行位软链

```bash
git clone --recurse-submodules https://github.com/mxypoo/pi-qoder.git ~/Documents/pi-qoder
ln -sf ~/Documents/pi-qoder ~/.pi/agent/extensions/pi-qoder
ln -sf ~/Documents/pi-qoder/index.ts ~/.pi/agent/extensions/qoder.ts
```

安装完成后，直接输入 `pi` 即可正常使用。

---

## 常用命令

打开 `pi` 进入会话后，直接在输入框中输入命令：

| 快捷命令 | 说明 |
| :--- | :--- |
| `/qoder-login` | 启动 **Qoder CN (国内版)** 浏览器授权，扫码/手机登录后即可解锁全套国内模型（Qwen3 Coder Plus, DeepSeek-V3/R1 等） |
| `/qoder-login qoder` | 启动 **Qoder (国际版)** 浏览器授权（支持 Google / GitHub 登录，提供 DeepSeek-Flash 等免费模型） |
| `/qoder-status` | 查看当前已登录账号（UID、用户名、邮箱、Token 到期时间）及账号配额使用情况 |
| `/qoder-checkin` | 执行国内版每日签到，自动领取免费积分与权益 |
| `/qoder-update` | 会话内一键同步 GitHub 最新上游协议更新并报告当前 Commit 详情 |

---

## 版本维护与一键更新

当 Qoder 官方更新加密签名、接口路由或混淆字符表时，只需拉取上游子模块即可：

- **会话内一键更新**：在 `pi` 聊天输入框内输入 `/qoder-update`
- **命令行一键更新**：在系统终端运行：
  ```bash
  ~/.pi/agent/extensions/pi-qoder/update.sh
  ```

---

## 开源许可与致谢

- 核心协议逆向逻辑与 COSY 签名实现源自 [eghrhegpe/dsh-connect-qoder](https://github.com/eghrhegpe/dsh-connect-qoder)，在此致以崇高敬意。
- 本项目采用 [MIT 许可证](LICENSE) 开源。
