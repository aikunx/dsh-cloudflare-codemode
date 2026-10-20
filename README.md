# dsh-cloudflare-codemode

**把 Cloudflare 的全部 API 交给 AI —— 通过官方 Code Mode MCP，不封装任何单个接口。**

为 [DeepSeek Harness](https://www.deepseek.com/harness/) 提供 Cloudflare 全产品读写能力：
AI 拿到 `search` 与 `execute` 两个工具，就能动态访问 **2,500+ 个 Cloudflare API 端点**，
覆盖 Workers、DNS、R2、KV、D1、Pages、Zero Trust、AI Gateway……全部产品线。

附带一个可视化设置面板，支持 **OAuth 2.1 浏览器授权**与 **API Token** 两种接入方式，
凭据只保存在本机。

[![License: MIT](https://img.shields.io/badge/license-MIT-2f6f4f)](LICENSE)
[![DSH](https://img.shields.io/badge/dsh-0.2.1--rc.2-4d6bfe)](https://www.deepseek.com/harness/)
[![Node](https://img.shields.io/badge/node-%3E%3D22-339933)](https://nodejs.org/)

---

## 这是什么

Cloudflare 在 2025 年上线了官方的 **Code Mode MCP 服务器** `https://mcp.cloudflare.com/mcp`。
它不暴露几百个固定工具，而是只给两个：

| 工具 | 作用 |
| --- | --- |
| `search` | 在完整 OpenAPI 规格里检索端点、参数与请求体结构 |
| `execute` | 执行一段 JavaScript，通过 `cloudflare.request()` 调用任意 Cloudflare API |

配合 `docs`（文档问答）与 `whoami`（身份确认），AI 可以先查规格、再写代码调用——
这比"为每个产品手写一个工具"覆盖广得多，也永远不会因为 Cloudflare 加新接口而失效。

**本插件的职责很简单：让 DSH 里的模型用上这四个工具。**

---

## 为什么需要这个插件

DSH 自带 MCP 客户端（`@deepseek-ai/dsh-mcp-client`），但它定位是"配置即连接"：
地址、认证头都写死在 profile 配置里，改一次就要编辑 YAML 并重启宿主。

而 Cloudflare 的凭据是**会变的**——OAuth 访问令牌两小时过期、API Token 可能被吊销重建。
把明文 Token 写进 `cordis.patch.yml` 既不安全，也不灵活。

本插件的做法是：**在本地起一个只做认证注入的代理**，MCP 协议仍由官方客户端处理。

---

## 工作原理

```
┌──────────────┐
│   AI 模型     │
└──────┬───────┘
       │  mcp__cloudflare__search / execute / docs / whoami
       ▼
┌──────────────────────────────┐
│ @deepseek-ai/dsh-mcp-client  │  ← DSH 官方包，负责 MCP 协议
│   （随 DSH 一起提供）          │
└──────────────┬───────────────┘
               │  Streamable HTTP
               ▼
┌──────────────────────────────┐
│  127.0.0.1:18923/mcp         │  ← 本插件：注入 Authorization 的代理
│  每次请求重读本机凭据文件       │
└──────────────┬───────────────┘
               │  OAuth / Bearer Token
               ▼
┌──────────────────────────────┐
│ https://mcp.cloudflare.com   │  ← Cloudflare 官方 Code Mode MCP
└──────────────────────────────┘
```

**这层代理换来三件事：**

1. **密钥不进配置** —— `cordis.patch.yml` 里只有端口号，凭据在独立文件里（权限 `0600`）。
2. **改 Token 立刻生效** —— 代理逐请求读取凭据，面板保存后下一次调用就换上了，无需重启。
3. **OAuth 自动续期** —— 访问令牌过期时在代理内透明刷新，对 MCP 客户端完全无感。

本插件**不封装任何 Cloudflare 接口**。全部 2,500+ 端点都来自 Cloudflare 自己维护的规格。

---

## 功能

- **全产品读写**：DNS、Workers、Pages、R2、KV、D1、Zero Trust、R2、Images、Stream、Logpush……
- **双认证**：OAuth 2.1 浏览器授权（PKCE + 动态客户端注册）或 API Token
- **可视化面板**：设置页「Cloudflare 全功能管家」——认证切换、连接状态、工具数量、权限清单
- **连接自检**：一键跑完整 MCP 握手（initialize → tools/list），如实回报发现的工具
- **状态实时**：显示 MCP 桥接是否已连接、已注册的工具名
- **零 DSH 依赖**：Host 半只用 Node 内置模块，不 `import` 任何 `@deepseek-ai/*`，因此不受内核版本闸门限制

---

## 安装

> 需要 DSH **0.2.x**（已验证 `0.2.1-rc.2`），Node.js **≥ 22**。

### 方式一：GitHub 源（推荐）

```bash
dsh plugin --profile web add github:aikunx/dsh-cloudflare-codemode
```

桌面端（profile 名为 `desktop`）：

```bash
dsh plugin --profile desktop add github:aikunx/dsh-cloudflare-codemode
```

### 方式二：DSH Desktop 插件管理器

打开 **设置 → 插件 → 安装插件**，填入仓库地址：

```
https://github.com/aikunx/dsh-cloudflare-codemode
```

安装完成后**完全退出应用并重新打开**。

### 方式三：本地目录

```bash
git clone https://github.com/aikunx/dsh-cloudflare-codemode.git
dsh plugin --profile web add ./dsh-cloudflare-codemode
```

### 安装后

1. **重启 DSH**（新增 Host 插件必须重启才会加载）
2. 浏览器按 `Ctrl + Shift + R` 强制刷新页面
3. 进入 **设置 → Cloudflare 全功能管家**

---

## 配置

### 方式 A：OAuth 2.1 授权（推荐）

1. 设置面板中选择 **OAuth 授权** 标签
2. 点「开始 OAuth 授权」
3. 浏览器会打开 Cloudflare 授权页，登录并授权
4. 回调完成后面板状态变为「已连接」

插件使用 **动态客户端注册 + PKCE**，不需要你预先创建 OAuth App。
令牌自动续期，`offline_access` 让刷新令牌长期有效。

### 方式 B：API Token

1. 面板中选择 **API Token** 标签
2. 填入 **Account ID**（控制台右侧「账户 ID」，32 位十六进制）
3. 填入 **API Token**
4. 点「保存并测试连接」

> Token 保存后不再回显，输入框留空表示保留原值。

---

## 🔑 Token 权限清单

Cloudflare **没有**「一键全权限」复选框，必须逐项勾选。要让写操作（部署 Workers、改 DNS、管 R2）可用：

1. 打开 [Dash → My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens)
2. **Create Custom Token**
3. **Permissions** 区域，把下表中 **Account** 与 **Zone** 两个作用域的权限组设为 `Edit`（不是 `Read`）

| 作用域 | 权限组 | 级别 | 用途 |
| --- | --- | --- | --- |
| Zone | DNS | Edit | 增删改 DNS 记录 |
| Zone | Workers Routes | Edit | 绑定路由 |
| Zone | Zone Settings | Edit | 缓存、SSL 等配置 |
| Account | Workers Scripts | Edit | 部署 / 删除 Worker |
| Account | Cloudflare Pages | Edit | 部署静态站 |
| Account | Workers KV Storage | Edit | 键值存储 |
| Account | D1 | Edit | 数据库 |
| Account | Workers R2 Storage | Edit | 对象存储（需先在控制台开通 R2） |

4. **Account Resources** → `Include` → **All accounts**
5. **Zone Resources** → `Include` → **All zones**
6. 保存后立刻粘贴到面板，点「保存并测试连接」

> **只给 `Read` 会怎样？** 列表、查询能过，但部署、改记录、建桶会全部返回 `403`。

---

## 使用

连接成功后，直接用自然语言对话即可：

```
列一下我账号下所有的 Zone
→ execute: GET /zones

给 example.com 加一条 A 记录，指向 1.2.3.4
→ search 找到 POST /zones/{zone_id}/dns_records
→ execute 创建

把这个目录部署到 Workers
→ search 找到上传会话与部署端点
→ execute 分步上传并部署

我的 D1 里有多少张表？
→ execute: POST /accounts/{id}/d1/database/{db}/query
```

模型会先用 `search` 查规格、再用 `execute` 执行——**不需要你记任何 API 路径**。

---

## 配置项

`cordis.patch.yml` 中本插件行支持的字段：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `port` | `18923` | 本地代理监听端口（仅绑定 `127.0.0.1`） |

> 改端口后必须同步修改同一文件里 `cloudflare-codemode-mcp` 行的 `url`。

凭据文件：`~/.dsh/dsh-cloudflare-codemode.json`（权限 `0600`）

```jsonc
{
  "authMode": "oauth",        // "oauth" | "token"
  "accountId": "…32 位十六进制…",
  "apiToken": "…",            // authMode=token 时使用
  "oauth": {                  // authMode=oauth 时使用
    "clientId": "…",
    "accessToken": "…",
    "refreshToken": "…",
    "expiresAt": 1792523692052
  }
}
```

---

## 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| 面板显示「未连接」，工具列表为空 | 尚未配置凭据。填入 Token 或完成 OAuth 后等待约 30 秒（桥接有重连间隔）。 |
| 保存了 Token 但工具一直不出现 | 检查是否已重启 DSH。首次启动时若还没有凭据，桥接会持续重试（预算已设为 2000 次，约 8 小时）。 |
| 面板报「Cloudflare 拒绝了当前凭据（401）」 | Token 失效或被吊销，重新授权。 |
| 某个操作返回 `403` | Token 权限不足，按上面的[权限清单](#-token-权限清单)补齐对应的 `Edit` 权限。 |
| R2 操作报 `10042` | R2 未在该账户开通，需先去 [R2 控制台](https://dash.cloudflare.com/?to=/:account/r2) 启用。 |
| 端口 18923 被占用 | 修改 `cordis.patch.yml` 中两处端口后重启。 |

查看实时状态（本机）：

```bash
curl http://127.0.0.1:18923/cloudflare-codemode/state
```

---

## 安全

- **凭据只存本机**：`~/.dsh/dsh-cloudflare-codemode.json`，权限 `0600`，永不写入 profile 配置。
- **代理只绑回环**：`127.0.0.1:18923`，不对外网开放。设置面板路由校验同源，拒绝跨站请求。
- **OAuth 令牌自动刷新**：刷新失败会明确报错，不会静默降级。
- **不收集任何数据**：没有遥测，没有第三方中转。请求只在你、本机代理与 Cloudflare 之间流动。
- **面板永不回显 Token**：只显示「已保存 / 未保存」。

> ⚠️ **切勿把 Token 粘贴到聊天窗口或 Issue**。本插件的设计目的之一就是让凭据不经过对话。

---

## 兼容性

| 项目 | 范围 |
| --- | --- |
| DSH | 0.2.x（已验证 0.2.1-rc.2） |
| profile | `web`、`desktop` 均可 |
| 平台 | Windows / macOS / Linux |
| Node.js | ≥ 22 |

**不依赖任何 `@deepseek-ai/*` 运行时导入**，因此不会被 DSH 的版本闸门拦截，
也不会因为内核升级而失效。唯一的外部依赖是 DSH 自带的 `@deepseek-ai/dsh-mcp-client`。

---

## 目录结构

```
dsh-cloudflare-codemode/
├── package.json          # 包元数据 + dsh.bundle / dsh.client 声明
├── cordis.patch.yml      # 两行：本插件 Host 半 + 官方 MCP 客户端
├── lib/
│   ├── index.js          # Host 半：配置存储、认证代理、设置路由
│   └── client.js         # Client 半：设置面板（纯 __ModuleLoader__，无构建步骤）
├── locale/
│   ├── zh.json           # 中文标题与描述
│   └── en.json           # 英文标题与描述
├── icon.svg
└── LICENSE
```

---

## 开发

无需构建步骤。改 `lib/client.js` 刷新页面即可；改 `lib/index.js` 需重启宿主。

语法检查：

```bash
node --check lib/index.js
node --check lib/client.js
```

---

## 相关链接

- [Cloudflare Code Mode MCP 文档](https://developers.cloudflare.com/agents/model-context-protocol/)
- [DeepSeek Harness](https://www.deepseek.com/harness/)

---

## License

[MIT](LICENSE)

本项目为独立第三方插件，与 Cloudflare, Inc. 及 DeepSeek 均无隶属或背书关系。
使用本插件访问 Cloudflare API 时，你需自行遵守 Cloudflare 的服务条款。
