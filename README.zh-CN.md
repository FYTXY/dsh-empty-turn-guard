# dsh-empty-turn-guard

[English](./README.md) | **简体中文**

给 [DSH（DeepSeek-Harness）](https://github.com/deepseek-ai) 用的一个小插件，只针对一种失败：模型回复**只剩协议残渣**——既没有正文、也没有工具调用——而 DSH 把这当成"正常说完了"。本插件把它改判成一个**可重试的错误**，让这一步重试，而不是静默结束回合。

它是一个标准 DSH **bundle**（自带 `cordis.patch.yml` 的包），安装不修改 DSH 任何文件。

## 特性

- **拦住"半截回答"那一轮。** 当回复只剩 `</｜｜DSML｜｜ calls>`、`<thinking> </thinking>` 或纯标点时，这一步会带退避重试，而不是被当成一条完整消息落盘。
- **两处设置入口。** **设置 → 内置插件 →「空回合守卫」** 一个独立 tab，以及侧边栏 **「插件」** 面板上的同名卡片，改的是同一个开关。
- **不会误伤正常回复。** 三个条件必须同时成立：结束原因是 `stop`、没有观察到任何工具调用、去掉协议标记后正文为空。单词回答、单个 `?`、只是提到了标签的正常文字，都原样放行。
- **不碰截断。** `max-tokens` 是"真回答被截短"，本来就是可见的独立结果，不归本插件管。
- **零运行时依赖。** 宿主半只引一个 schema 库；浏览器半是手写 bundle，不需要构建工具。
- **日志只记长度，不记内容。** 诊断信息里是 `text=24ch`，模型输出不会经本插件写进日志文件。

## 安装

```sh
# 直接从 GitHub 装（现在就能用）
dsh plugin --profile <你的profile> add github:FYTXY/dsh-empty-turn-guard

# 从本地源码 link 安装（自己开发用）
dsh plugin --profile <你的profile> add link:<本目录绝对路径>

# 从 npm 装——尚未发布，这条现在会报 E404
dsh plugin --profile <你的profile> add dsh-empty-turn-guard
```

`dsh plugin … add` 会把参数转给 pnpm，所以 GitHub 简写、tag、分支都能用（例如 `github:FYTXY/dsh-empty-turn-guard#v0.4.0`）。

装完重启 DSH，进 **设置 → 内置插件 →「空回合守卫」**，把开关打开。

<details>
<summary>不用 CLI 的手工安装</summary>

1. 把本目录放到固定位置，例如 `~/.dsh/plugins/dsh-empty-turn-guard`。
2. 在 profile 的 `node_modules` 里建软链 / junction 指向它。
3. 在 profile 的 `package.json` 里，把包名同时加进 `dependencies` 和 `dsh.profile.bundles` 数组。
4. 重启 DSH。

不要改用"往 `cordis.patch.yml` 里插一行裸路径"的老办法——那样它只是个普通模块、不算 bundle，**设置里也就没有那个开关**。

用 `link:` 或手工方式安装时，`@deepseek-ai/schemastery` 要从 DSH 自带的那份解析。如果 node 报 `ERR_MODULE_NOT_FOUND: @deepseek-ai/schemastery`，建一个 junction 指过去：

```powershell
New-Item -ItemType Junction -Path ".\node_modules\@deepseek-ai\schemastery" `
  -Target "$env:USERPROFILE\.dsh\profiles\<profile>\node_modules\@deepseek-ai\schemastery"
```

从 GitHub 正常安装时 pnpm 会自己处理，不用这一步。

</details>

## 配置

### 1. 开关

两个入口改的是同一件事（profile `package.json` 里 `dsh.profile.bundles` 的这一项），用哪个都行：

| 入口 | 展示内容 |
| --- | --- |
| 设置 → 内置插件 → **「空回合守卫」** | 插件自己的配置页：开关、当前状态说明、保存 / 丢弃 |
| 侧边栏 → **「插件」** 面板 | bundle 卡片上的同一个开关 |

**关掉**会卸载本插件、`llm/stream` 恢复原样（空回合又会静默完成）；**打开**会重新加载守卫。两者都不需要重装、立即生效。

插件面板里本插件那一**行**的开关是灰色的，这是正常的：DSH 只允许通过 profile 自己的 patch 文件启停"行"，而本插件的行来自包自带的 `cordis.patch.yml`，所以行开关锁定——真正生效的是**包的开关**。

### 2. 只禁用逻辑、保留安装

想留着包但跳过拦截，给这一行加 `config`：

```yaml
- id: dsh-empty-turn-guard
  name: 'dsh-empty-turn-guard'
  config:
    enabled: false
```

`enabled` 是 volatile 字段，运行时是活引用而不是冻结值；守卫每次请求都会重读它，所以设置页拨开关对下一次模型请求就生效，无需重启。

### 3. 确认它生效了

宿主日志（Windows：`%APPDATA%\DSH Desktop\logs\host\dsh-<日期>.log`；Linux：`~/.config/DSH Desktop/logs/host/`）里会出现：

```
[dsh-empty-turn-guard] empty-turn-guard: mounted (markup-only stops become EMPTY_RESPONSE retries)
```

真的拦到一次空回合时：

```
[dsh-empty-turn-guard] rewriting an empty stop (text=24ch) into EMPTY_RESPONSE
```

紧接着通常还能看到 `llm/retry` / `llm/retry-started`——那就是重试在跑。

## 工作原理

```
LLM 调用
  └─ llm/stream  ◀── 本插件包在这里（global，前置）
     └─ 适配器流（openai-responses | anthropic-messages）
        └─ 分块：block-start / text-delta / block-end / usage / finish

遇到 finish：
  reason.kind === "stop"
    且没有观察到工具调用
    且 stripMarkup(正文) === ""        ⇒  改写成 error EMPTY_RESPONSE
  否则                                  ⇒  原样放行

error EMPTY_RESPONSE
  └─ @deepseek-ai/dsh-llm-retry：它在 DEFAULT_RETRYABLE_CODES 里
     └─ 重试这一步（最多 5 次，初始 500ms，上限 10s，10% 抖动）
```

`llm/stream` 是每次模型调用都要过的唯一漏斗，瀑布式事件允许监听者**包裹**适配器的分块流，而不是事后修补。改写 `finish` 分块——而不是改文字或往对话里插消息——能保持历史干净，并直接复用 provider 已经声明的重试机制。

两个过滤条件让拦截保持克制：没有声明 `tools` 的请求直接跳过（标题生成、压缩这类后台调用走同一条流，空回复是正常的）；`max-tokens` 跳过（截断是真实回答）。

它针对的失败形态、背后的实测数据、以及"换协议为什么不管用"，都写在 **[docs/root-cause.md](docs/root-cause.md)**。

## 兼容性

- **DSH `0.2.0-rc.2`**（在该版本验证通过）。
- **Node.js >= 22。**
- 只用既有接缝：`llm/stream` 瀑布与 `EMPTY_RESPONSE` 错误码，不修改 DSH 任何文件。
- `@deepseek-ai/schemastery` 是**对等依赖**，由 DSH 提供。
- `Config` 里必须保留 `.volatile()` 字段：`@deepseek-ai/dsh-settings` 会静默丢弃没有任何 volatile 字段的命名空间，设置卡片会消失。详见 [docs/root-cause.md](docs/root-cause.md) 末尾。

## 非目标

- **不修中转站**：残渣仍会出现在正文里，只是不再"假装完成"。
- **不清洗历史消息**：已经落盘的怪标记不会被动。
- **不管退化刷屏**：一路重复到 `max-tokens` 的情况本来就有可见结果。
- **不保证重试一定成功**：如果中转持续只吐残渣，重试会耗尽并给出明确报错——仍好过静默半截。

## 开发

没有构建步骤，`lib/index.js` 与 `lib/client.js` 就是发布产物。

```sh
npm run check   # 对两个入口跑 node --check
npm test        # 对 tests/ 跑 node --test
```

`lib/client.js` 是手写的 ModuleLoader bundle，因为浏览器侧是通过求值 `window.__ModuleLoader__.load({ id, factory })` 加载的。它只允许 `require` 三样东西：`react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives`。不要为它引入打包器。

评审标准见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全边界见 [SECURITY.md](SECURITY.md)。

## 目录结构

```
dsh-empty-turn-guard/
├── lib/index.js           # 宿主半：llm/stream 守卫（零运行时依赖）
├── lib/client.js          # 浏览器半：设置页 / 插件面板的卡片
├── cordis.patch.yml       # bundle patch：把插件行挂进配置树
├── package.json           # dsh.bundle.patch 与 dsh.client 指向上面两个入口
├── tests/                 # 两个半边的 node:test 套件
│   ├── guard.test.mjs
│   └── client-bundle.test.mjs
├── docs/root-cause.md     # 本插件针对的失败形态与取证
├── .github/workflows/     # CI：Linux / Windows × Node 22 / 24
├── CHANGELOG.md
├── CONTRIBUTING.md
├── SECURITY.md
└── LICENSE
```

## 卸载

```sh
dsh plugin --profile <你的profile> remove dsh-empty-turn-guard
```

或者去 **设置 → 内置插件 →「空回合守卫」** 把开关关掉。

## 许可证

[MIT](LICENSE)
