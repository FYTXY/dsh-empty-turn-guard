# dsh-empty-turn-guard

[English](./README.md) | **简体中文**

给 [DSH（DeepSeek-Harness）](https://github.com/deepseek-ai) 用的一个小插件，专治一类失败：模型的回复**不是一条能用的回答**——话说一半停在漏出来的协议标记上、流式响应中途不再出块也永远不结束、对着空的 `<thinking>` 反复刷屏、或者把一段思考过程当回答交了回来。DSH 会把这些都当成"正常说完了"；本插件把它们改判成**可重试的错误**，让这一步重试，而不是静默结束回合。

它是一个标准 DSH **bundle**（自带 `cordis.patch.yml` 的包），安装不修改 DSH 任何文件。

## 特性

- **拦住"话说一半"的那一轮。** 实测 11 946 条 assistant 消息后发现，最常见的形态并不是"回复为空"，而是正文写着写着停住，后面跟着 `</｜｜DSML｜｜ invoke>` / `</｜｜DSML｜｜ calls>` —— 这正是用户看到的"输出一半卡死"。现在会被识别并重试。
- **拦住"一开口就是标记"的回答。** 中转服务把正文丢了、只吐出参数块时，这条回复从头就不是回答。
- **拦住"调用永远没闭合"。** 先讲人话，接着 `<parameter name=…` 却始终没有 `</parameter>`：模型开始拼工具调用，流就在参数里断了。
- **拦住"只说不做"的宣告。** 六步工具调用都跑完了，最后一步只写一句"接下来要干什么"就停了——「读 L4320-4429 区间和 L2667 附近（main）。」、「Let me run it.」。工具没调用、也没报错，这一轮被记成正常完成，而中转服务把调用块整个吞掉了。判据只看最后一行，而且要求这条回复至少已经写了 100 字符。
- **拦住卡死的流。** 90 秒没有新分块 → `TIMEOUT`；流结束了却没有 `finish` 分块 → `TRANSPORT`。已经到达的正文照常交付，不会丢。
- **刷屏当场掐断。** 出现 12 对空的 `<thinking> </thinking>` 且没有其他内容时立刻中断上游流，不必等它自己生成完——实测最坏的一次吐了 255 对才结束。
- **按位置判定，所以不会吞掉真回答。** 判据看的是标记**长在哪里**，而不是有没有标记：实测 130 条含残渣的消息里，有 43 条是**正确回答**——模型在解释这个 bug 时把标记原文引用了出来。这些全部原样放行，包括一条 1 750 字的报告和一条整段包在未闭合 `<thinking>` 里的 2 089 字正确回答。
- **六个开关，不暴露数字。** 一个总开关加每个判据一个；阈值写死成常量，免得设置页里一个数字就被调成误伤。
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

`dsh plugin … add` 会把参数转给 pnpm，所以 GitHub 简写、tag、分支都能用（例如 `github:FYTXY/dsh-empty-turn-guard#v0.6.0`）。

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

### 1. 六个开关

都在 **设置 → 内置插件 →「空回合守卫」** 这个 tab 里；总开关同时也在侧边栏 **「插件」** 面板的 bundle 卡片上。阈值不暴露——它们是 `lib/index.js` 里的常量，因为每一个都是从实测样本里选出来的，留个数字输入框只会让人把它调成误伤。

| 开关 | 默认 | 它认为哪一回合算失败 |
| --- | --- | --- |
| `enabled` | 开 | 总开关。关掉 = 整个守卫卸载。 |
| `toolCallResidue` | 开 | 回复以标记结尾、以标记开头，或者走进一个永远没闭合的 `<parameter>` 块。 |
| `narrationStop` | 开 | 回复以一句短宣告结束——「读 L4320-4429 区间和 L2667 附近（main）。」、「Let me run it.」——然后就没有了，工具没调用。只看最后一行，且要求这条回复至少已写满 100 字符。 |
| `streamStall` | 开 | 90 秒没有新分块（`TIMEOUT`），或流结束却没有 `finish` 分块（`TRANSPORT`）。 |
| `repetition` | 开 | 12 对空的 `<thinking> </thinking>` 且正文空无一物。当场掐断，不等它循环完。 |
| `thinkingLeak` | **关** | 短回复（去掉标记后 ≤ 400 字符）整段待在一个未闭合的 `<thinking>` 里。默认关：实测有一条完整正确的回答只是丢了闭合标签，两者只能靠长度区分。 |

关掉 `enabled` 会卸载插件、`llm/stream` 恢复原样（半截回答又会静默完成）。其余五个是逐请求判定，拨完对下一次模型调用就生效，无需重启。

两个入口改的是同一件事（profile `package.json` 里 `dsh.profile.bundles` 的这一项），用哪个都行：

| 入口 | 展示内容 |
| --- | --- |
| 设置 → 内置插件 → **「空回合守卫」** | 插件自己的配置页：六个开关、当前状态说明、保存 / 丢弃 |
| 侧边栏 → **「插件」** 面板 | bundle 卡片上的总开关 |

插件面板里本插件那一**行**的开关是灰色的，这是正常的：DSH 只允许通过 profile 自己的 patch 文件启停"行"，而本插件的行来自包自带的 `cordis.patch.yml`，所以行开关锁定——真正生效的是**包的开关**。

### 2. 只关掉某条判据、保留安装

想留着包但跳过某条判据，给这一行加 `config`：

```yaml
- id: dsh-empty-turn-guard
  name: 'dsh-empty-turn-guard'
  config:
    repetition: false
```

所有字段都是 volatile 的，运行时是活引用而不是冻结值；守卫每次请求都会重读全部开关。

### 3. 确认它生效了

宿主日志（Windows：`%APPDATA%\DSH Desktop\logs\host\dsh-<日期>.log`；Linux：`~/.config/DSH Desktop/logs/host/`）里会出现：

```
[dsh-empty-turn-guard] empty-turn-guard: mounted (broken steps become retryable errors)
```

真的判到一次时，日志会点明是哪条判据、丢掉了多少字符、改成了哪个错误码：

```
[dsh-empty-turn-guard] rewriting a markup-only stop (text=24ch) into EMPTY_RESPONSE
[dsh-empty-turn-guard] rewriting a tool-call-residue stop (text=159ch) into TRANSPORT
[dsh-empty-turn-guard] rewriting a narration-only stop (text=270ch) into TRANSPORT
[dsh-empty-turn-guard] rewriting a stream-stalled attempt (no chunk for 90000ms) into TIMEOUT
[dsh-empty-turn-guard] rewriting a stream-truncated attempt (no finish chunk) into TRANSPORT
```

紧接着通常还能看到 `llm/retry` / `llm/retry-started`——那就是重试在跑。

## 工作原理

```
LLM 调用
  └─ llm/stream  ◀── 本插件包在这里（global，前置）
     └─ 适配器流（openai-responses | anthropic-messages）
        └─ 分块：block-start / text-delta / block-end / usage / finish

流式过程中：
  探测已有正文
    空 thinking 对 ≥ 12 且剥完为空        ⇒  掐断上游，改写成 error EMPTY_RESPONSE
    90 秒没有新分块                        ⇒  改写成 error TIMEOUT
    流结束了却没有 finish 分块              ⇒  改写成 error TRANSPORT

遇到 finish：
  reason.kind === "stop" 且没有观察到工具调用
    stripMarkup(正文) === ""              ⇒  error EMPTY_RESPONSE   （只有标记）
    endsInResidue(正文)                   ⇒  error TRANSPORT        （停在标记上）
    startsInResidue(正文)                 ⇒  error TRANSPORT        （开口就是标记）
    hasUnclosedCall(正文)                 ⇒  error TRANSPORT        （调用没闭合）
    narrationStop 开 && endsInNarration(正文) ⇒  error TRANSPORT      （只说不做）
    thinkingLeak 开 && isThinkingLeak(…)  ⇒  error EMPTY_RESPONSE   （可选）
  否则                                    ⇒  原样放行

error
  └─ @deepseek-ai/dsh-llm-retry：三个错误码都在 DEFAULT_RETRYABLE_CODES 里
     └─ 重试这一步（最多 5 次，初始 500ms，上限 10s，10% 抖动）
```

`llm/stream` 是每次模型调用都要过的唯一漏斗，瀑布式事件允许监听者**包裹**适配器的分块流，而不是事后修补。改写 `finish` 分块——而不是改文字或往对话里插消息——能保持历史干净，并直接复用 provider 已经声明的重试机制。这样失败的一步不会追加 `assistant/message`，那半截文字也不会进到会话记录里。

**看位置，不看有无。** 整个设计围绕一个实测事实：130 条含残渣的回复里，43 条是**正确回答**——模型在解释这个 bug 时把标记引用了一遍。所以"有标记"什么也证明不了。真正的分界是：最后一个标记之后再没有正文（`endsInResidue`）、或者开头 40 字符里第一个标记之前没有正文（`startsInResidue`）、或者 `<parameter>` 块开了却始终没闭合（`hasUnclosedCall`）。

`HEAD_WINDOW = 40` 这个常量是关键：实测把窗口放到 80 / 120 / 300 都会误伤，因为正确回答里被引用的标记落在第 65–71 字符处。

**「只说不做」这条只读一行。** `endsInNarration` 只看最后一个非空行，并且要同时满足：不超过 60 字符、以动作动词开头、不含逗号或分号、不含「要不要我 / 需要我 / 吗」这类把决定交回给用户的语气。整条回复不足 100 字符时一律不判——「先读一下配置。」和正常的短回答无法区分，而实测每一条真失败都是先写了 143 字符以上的正文才落到最后那行。有两种形态是**刻意不抓**的：带逗号的两段宣告（「然后读 A，再读 B。」）和带逗号的单句；因为把判据放宽到能抓它们，就会开始咬正常的解释性收尾。

两个过滤条件让拦截保持克制：没有声明 `tools` 的请求直接跳过（标题生成、压缩这类后台调用走同一条流，空回复是正常的）；`max-tokens` 跳过（截断是真实回答）。

**只重试，不解析。** 本插件刻意不把漏出来的 DSML 还原成工具调用：解析器一旦读错一个参数，就是执行了错误的命令；重试只是多花一次往返。

它针对的失败形态、背后的实测数据、以及"换协议为什么不管用"，都写在 **[docs/root-cause.md](docs/root-cause.md)**。

## 兼容性

- **DSH `0.2.0-rc.2`**（在该版本验证通过）。
- **Node.js >= 22。**
- 只用既有接缝：`llm/stream` 瀑布与三个默认可重试的错误码（`EMPTY_RESPONSE` / `TIMEOUT` / `TRANSPORT`），不修改 DSH 任何文件。自定义错误码永远不会被 `@deepseek-ai/dsh-llm-retry` 重试，所以三个判据都落在这三个既有码里。
- `@deepseek-ai/schemastery` 是**对等依赖**，由 DSH 提供。
- `Config` 里必须保留 `.volatile()` 字段：`@deepseek-ai/dsh-settings` 会静默丢弃没有任何 volatile 字段的命名空间，设置卡片会消失。详见 [docs/root-cause.md](docs/root-cause.md) 末尾。

## 非目标

- **不修中转站**：残渣仍会出现在正文里，只是不再"假装完成"。
- **不把残渣解析回工具调用**：这是刻意的——解析器一旦读错一个参数，就是执行了错误的命令，比重试一次更糟。
- **不清洗历史消息**：已经落盘的怪标记不会被动。
- **不覆盖所有残渣位置**：夹在第 40 到第 400 字符之间、两侧都有正文的残渣仍会放行（实测 139 条里漏 2 条）。把窗口放大反而会开始吃掉正确回答，这个取舍记在 `docs/root-cause.md` 里。
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
