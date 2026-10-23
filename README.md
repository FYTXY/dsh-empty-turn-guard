# dsh-empty-turn-guard

**中文** | [English](./README.en.md)

给 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai) 用的一个小插件：当模型回复**只剩协议残渣、既没有正文也没有工具调用**的时候，把它改判成一个**可重试的错误**，而不是当成"正常说完了"。

装上以后，你有**两个**开关入口：

- **设置 → 内置插件 →「空回合守卫」**：一个独立 tab，带开关、说明与保存/丢弃。
- **侧边栏 →「插件」面板**：同名卡片，同一份开关（改的是 `dsh.profile.bundles`）。

---

## 它解决什么

现象：AI 回复输出到一半就停住，气泡里可能是

- 一句没说完的话，
- 或者只有 `</｜｜DSML｜｜ parameter>` `</｜｜DSML｜｜ invoke>` `</｜｜DSML｜｜ calls>` 这类标记，
- 或者只有 `<thinking> </thinking>` 空标签，

然后下面出现一个「继续」按钮。点继续，模型才接着干——但那一步本来要做的事已经丢了。

根因（不是 DSH 崩溃，是"空回合被判定为正常完成"）：

1. 中转站把模型**原生的工具调用标记**当纯文本塞回正文，然后照发一个正常的 `stop`。DSH 里没有任何代码认识 `｜｜DSML｜｜` 或 `<thinking>`，只能当正文渲染。
2. `@deepseek-ai/dsh-agent-loop` 判断一轮是否结束时**只看有没有工具调用**：`toolCalls.length === 0 → { kind: "completed" }`。
3. `@deepseek-ai/dsh-llm-pi-ai` 的空内容护栏只检查**内容块数量**：`message.content.length === 0`。残渣块数 = 1，护栏直接放行。

于是「只有一个残渣块」被当成完整回复落盘，UI 如实显示"已完成" + 「继续」。

本插件在 `llm/stream` 瀑布上包一层，统计这次尝试到底产出了什么；当 `stop` 同时满足下面三条时，把结束原因改写成 `EMPTY_RESPONSE` 错误：

1. 结束原因是 `stop`（不是 `max-tokens`）；
2. 整个尝试没有任何工具调用；
3. 把正文里的协议残渣（`｜｜DSML｜｜` 标记、`<thinking>`/`</thinking>`、`<返璞归真>`）和空白全部去掉后，**什么都不剩**。

`EMPTY_RESPONSE` 在 DSH 默认的可重试集合里，所以 `@deepseek-ai/dsh-llm-retry` 会**自动带退避重试**这一步（默认最多 5 次）。重试成功后你根本不会察觉；连续失败才会看到明确的错误，而不是一个假装成功的半截回复。

---

## 安装

### 方式一：从 npm 安装（推荐给别人用）

```bash
dsh plugin --profile <你的profile> add dsh-empty-turn-guard
```

装完打开 DSH，进 **设置 → 内置插件 →「空回合守卫」**（或侧边栏 **「插件」** 面板），把开关打开。

### 方式二：直接从 GitHub 装（还没发 npm 时用这个）

```bash
dsh plugin --profile <你的profile> add github:FYTXY/dsh-empty-turn-guard
```

`dsh plugin ... add` 只是把参数转给 pnpm，所以 pnpm 支持的 GitHub 简写、`git+https://...`、tag/分支都能用（例如 `github:FYTXY/dsh-empty-turn-guard#v0.3.1`）。

### 方式三：从本地源码 link 安装（自己开发用）

```bash
git clone https://github.com/FYTXY/dsh-empty-turn-guard.git dsh-empty-turn-guard
dsh plugin --profile <你的profile> add link:<上面目录的绝对路径>
```

### 方式四：完全手工（不想用 CLI）

1. 把本目录放到任意位置，例如 `~/.dsh/plugins/dsh-empty-turn-guard`。
2. 在 profile 的 `node_modules` 里建一个软链/ junction 指向它；
3. 在 profile 的 `package.json` 里：
   - 把包名加进 `dependencies`；
   - 把包名加进 `dsh.profile.bundles` 数组。
4. 重启 DSH。

> 不要用"往 `cordis.patch.yml` 里插一行裸路径"的老办法——那样它不会被当成 bundle，**设置里也就没有那个开关**。

> 用 link / 手工方式安装时，本包依赖的 `@deepseek-ai/schemastery` 要从 profile 已有的那份解析。如果 node 报 `ERR_MODULE_NOT_FOUND: @deepseek-ai/schemastery`，在本包目录里建一个 junction 指过去：
>
> ```powershell
> New-Item -ItemType Junction -Path ".\node_modules\@deepseek-ai\schemastery" `
>   -Target "$env:USERPROFILE\.dsh\profiles\<profile>\node_modules\@deepseek-ai\schemastery"
> ```
>
> 从 npm / GitHub 正常安装时 pnpm 会自己装好依赖，不用管这一步。

---

## 在设置里启用 / 停用

有两个入口，改的是同一件事（profile `package.json` 的 `dsh.profile.bundles`），热生效、不需要卸载：

**入口一：设置 → 内置插件 →「空回合守卫」**

这是插件自带的配置页（客户端半 `lib/client.js` 注册到 `settings.plugins.tab`）。里面有开关、当前状态说明，以及保存 / 丢弃。

**入口二：侧边栏 →「插件」面板**

DSH 的插件管理页会列出每个被选中的 bundle，并给一个开关。本插件在列表里是一条卡片。

两处开关的效果一样：

- **关掉**：本插件不再加载，`llm/stream` 恢复原样（空回合又会静默完成）。
- **打开**：重新加载，恢复守卫。

> 说明：插件面板里本插件那一**行**的开关是灰色的。这是正常的——DSH 只允许通过 profile 自己的 patch 文件来启停"行"，而本插件的行是由包自带的 `cordis.patch.yml` 提供的，所以行的开关锁定，真正生效的是**包的开关**。

如果你还想在配置层面单独禁用它（例如临时保留包但跳过逻辑），也可以给这一行加 `config`：

```yaml
- id: dsh-empty-turn-guard
  name: 'dsh-empty-turn-guard'
  config:
    enabled: false
```

`enabled: false` 时插件照常加载但直接返回，不做任何拦截；在设置页拨开关则**无需重启**，下一次模型请求即生效（`enabled` 是 volatile 字段，运行时是活引用，插件每次请求都会重读）。

> 自己写这类"带表单的设置项"时有个坑值得记一笔：`Config` 的字段必须带 `.volatile()`（如 `z.boolean().default(true).volatile()`）。`@deepseek-ai/dsh-settings` 会用 `volatileForm(schema)` 过滤 schema，只保留 volatile 字段；一个都没有时整条插件被跳过，于是**设置里静默什么都不出现**——宿主不报错、插件也正常挂载，非常难查。官方 `dsh-agent-loop`、`dsh-agent-default-model` 都这么写。

---

## 怎么确认它生效了

宿主日志（`%APPDATA%\DSH Desktop\logs\host\dsh-<日期>.log`）里会出现：

```
[empty-turn-guard] empty-turn-guard: mounted (markup-only stops become EMPTY_RESPONSE retries)
```

真的拦到一次空回合时：

```
[empty-turn-guard] rewriting an empty stop (text=23ch) into EMPTY_RESPONSE
```

紧接着通常还能看到 `llm/retry` / `llm/retry-started` 事件——那就是重试在跑。

---

## 兼容性

- 需要 DSH `0.2.0-rc.2`（本插件在这一版上验证通过）。
- 依赖的事件 `llm/stream`、错误码 `EMPTY_RESPONSE` 都是 DSH 既有能力，不修改 DSH 任何文件。
- Node.js >= 22。

## 非目标（它不做什么）

- **不修中转站**：残渣还会出现在正文里，只是不会再"假装完成"。
- **不清洗历史消息**：已经落盘的怪标记不会被动。
- **不管 `max-tokens` 退化刷屏**：那种情况 DSH 会显示成可见的 `max-tokens` 结果，不属于本插件范围。
- **不保证重试一定成功**：如果中转持续只吐残渣，重试会耗尽，然后给出明确报错——这仍然比静默半截好。

## 卸载

```bash
dsh plugin --profile <你的profile> remove dsh-empty-turn-guard
```

或者去 **设置 → 内置插件 →「空回合守卫」** 把开关关掉。

## 目录结构

```
dsh-empty-turn-guard/
├── lib/index.js         # 宿主半：llm/stream 拦截逻辑（零运行时依赖）
├── lib/client.js        # 客户端半：设置页 / 插件面板里的那张带开关的卡片
├── cordis.patch.yml     # bundle patch：把插件行挂进配置树
├── package.json         # dsh.bundle.patch 指向上面那份 patch；dsh.client 指向客户端半
├── README.md / README.en.md
├── CHANGELOG.md
└── LICENSE
```

> `lib/client.js` 是**手写的浏览器 bundle**（`window.__ModuleLoader__.load(...)`），不需要构建工具；改完直接重启 DSH 即可。
> 它只 `require` 三个东西：`react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives`。

## 发布到 npm（本仓库维护者）

1. 改掉 `package.json` 里 `repository` / `homepage` / `bugs` 的 `CHANGE-ME`。
2. `npm publish`。
3. 别人就能用 `dsh plugin --profile <p> add dsh-empty-turn-guard` 装。

## License

MIT
