# Changelog

本项目的所有重要变更都记录在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 变更

- **README 安装章节调整顺序**：把「从 GitHub 安装」提到第一位（当前唯一可用的一键方式），npm 那条明确标注"尚未发布，现在会报 E404"。包本身还没发到 npm，文档先与现状对齐；发布成功后把 npm 挪回第一位即可。

## [0.4.0] — 2026-10-24

### 新增

- **正式测试套件 `tests/`**（`node:test`，无第三方依赖，47 个用例）：
  - `tests/guard.test.mjs`：覆盖宿主半的判定表 —— 8 种残渣形态都要改写成 `EMPTY_RESPONSE`，8 种真实回复（含单词回答、单个 `?`、正文里提到标签）都必须原样放行，以及 `max-tokens`、无 `tools` 的后台调用、开关的三种形态（挂载时关闭 / volatile 活引用 / 普通对象中途切换）。
  - `tests/client-bundle.test.mjs`：用假的 `__ModuleLoader__` 与最小 React 桩加载 `lib/client.js`，断言两个槽位注册、注入面、`SettingsForm` + 开关渲染、开关暂存布尔、只读态锁定、缺少 hook 时不渲染。
- **`docs/root-cause.md`**：把这个插件针对的失败形态写成文档 —— 四层因果链、逐行代码位置、4573 条消息的实测统计、换协议为什么不管用、以及上游真正该修的三个点。
- **`CONTRIBUTING.md` / `SECURITY.md`**：评审标准、兼容性约束（row id、volatile、peer 依赖），以及插件的安全边界（只改一个 `finish` 分块、无网络/文件/进程访问、日志不写正文）。
- **`.editorconfig`**、**`.gitattributes`**、**`.github/workflows/tests.yml`**（Linux / Windows × Node 22 / 24，跑 `npm run check` 与 `npm test`）。

### 变更

- **README 重组**：`README.md` 改为英文主文档（Features / Install / Configuration / How it works / Compatibility / Non-goals / Development / Repository Layout / License），中文版移到 `README.zh-CN.md` 并双向链接；删除 `README.en.md`。
- `@deepseek-ai/schemastery` 从 `dependencies` 改为 **`peerDependencies`**（由 DSH 提供，避免第二份副本），同时列入 `devDependencies` 供测试与 CI 解析。
- 移除未使用的 `cordis` 可选 peer 声明：本插件不 import cordis。
- `files` 增加 `docs`、`README.zh-CN.md`，移除 `README.en.md`；`scripts` 增加 `test`。

### 不变

- 拦截逻辑与客户端半行为完全未改，仅补充测试与文档。

## [0.3.1] — 2026-10-24

### 修复

- **设置页 / 插件面板里看不到「空回合守卫」**：根因是 `Config` 的字段缺少 `.volatile()` 标记。
  - `@deepseek-ai/dsh-settings` 的 `describe()` 拿到 `Config` 之后还要过一道 `volatileForm(schema)`，它**只保留最近的 volatile 祖先之下的字段**；整棵 schema 没有任何字段带 `meta.volatile` 时返回 `undefined`，这条插件行被整条跳过 —— 命名空间不存在，客户端 `whileServed([...])` 就永不触发注册，于是「设置 → 内置插件」没有 tab、侧边栏「插件」也没有卡片。
  - 现在 `enabled` 声明为 `z.boolean().default(true).volatile().description(...)`，与官方插件同写法（`dsh-agent-loop` 的 `maxParallelToolCalls`、`dsh-agent-default-model` 的 `provider` / `model` / `reasoningEffort`）。

### 变更

- **开关改为热生效**：volatile 字段运行时是以引用（`{ get() }`，见 `@deepseek-ai/cosmokit` 的 `createVolatile`）交给插件的，不再是裸布尔值。`apply` 因此改为每次请求读取一次 `enabled`，在设置里拨动开关即刻生效，无需重启。
- 同步更新 `README.md` / `README.en.md` 中关于 `Config` 的说明。

## [0.3.0] — 2026-10-23

### 新增

- **自带客户端半**（`dsh.client` + `lib/client.js`），让开关真正出现在设置里，而不再只是"能在侧边栏插件面板里启用"：
  - **设置 → 内置插件 →「空回合守卫」**：一个独立 tab，含开关、状态文字与保存/丢弃。
  - **侧边栏 →「插件」面板**：同名卡片，同一份开关。
- 两处注册都包在 `ctx.configForms.whileServed([HOST_NS], ...)` 里，宿主没提供配置命名空间时整块不出现。
- 新增宿主侧 `Config` 导出（`@deepseek-ai/schemastery` 的 `z.object({ enabled: z.boolean().default(true) })`）。
  - 这是"设置页能看到配置"的前提：`dsh-settings` 的 `schema(entry)` 只认 `entry.fiber.runtime.Config`，且有 `toJSON`；命名空间就是插件行的 `id`（`dsh-empty-turn-guard`）。
- `package.json`：新增 `exports["./client"]`、`dsh.client = { platform: "web", inject: [locale, ui-settings, ui-plugin-manager] }`、依赖 `@deepseek-ai/schemastery`；`scripts.check` 同时检查两个入口。
- 包内新增 `node_modules/@deepseek-ai/schemastery` 的 junction，指向 profile 里已有的那份。原因：包实体在 D 盘，Node 按 realpath 解析依赖，不加这层会 `ERR_MODULE_NOT_FOUND`。

### 不变

- 拦截逻辑本身完全未改；`config.enabled === false` 仍然在宿主侧短路（开关关闭 = 不拦截）。

## [0.2.0] — 2026-10-23

### 变更

- **改为标准 DSH bundle 包**：新增 `cordis.patch.yml`，并在 `package.json` 里声明 `dsh.bundle.patch`。
  - 因此它会出现在 **设置 → 插件** 的列表里，并带一个启用 / 停用开关（开关编辑 profile 的 `dsh.profile.bundles`）。
  - 因此可以通过 `dsh plugin --profile <p> add dsh-empty-turn-guard` 一条命令安装、分享给别人用。
- 插件标识 `name` 由 `empty-turn-guard` 改名为 `dsh-empty-turn-guard`，与包名 / entry id 一致（DSH STORE 上架契约要求 id 与包名一致）。
- 补充 `README.md`（中文）、`README.en.md`（英文）、`CHANGELOG.md`、`LICENSE`（MIT）。
- `package.json` 补齐 `description` / `keywords` / `repository` / `files` / `engines` / `exports`。
- 残渣识别更稳：新增"孤立标记"模式（流式增量里丢了开头 `<` 的 `｜｜DSML｜｜ calls>` 也能整段剥掉）；
  去除残渣后若只剩标点（如残缺的 `</`），同样判定为空回合。
- 包位置：实体放在 `D:\WORKSPACE.SUN\dsh-plugins\dsh-empty-turn-guard`（工作区内的插件目录），
  通过 profile `node_modules` 里的 junction 链接给 DSH 使用，不占用 DSH home 目录。

### 不变

- 拦截逻辑本身未改：`stop` + 零工具调用 + 去掉协议残渣后为空 → 改判 `EMPTY_RESPONSE` 触发既有重试。
- 零运行时依赖。

## [0.1.0] — 2026-10-23

### 新增

- 首个可用版本：以裸路径行（`cordis.patch.yml` 里 insert 一行 `file:///.../lib/index.js`）挂载。
- 在 `llm/stream` waterfall 上包一层，统计 tool-call 与正文；
  当 `stop` 且无工具调用、且正文去掉协议残渣后为空时，把 finish 改写成
  `{ kind: "error", failure: { code: "EMPTY_RESPONSE" } }`，交由 `@deepseek-ai/dsh-llm-retry` 重试。
- 识别的残渣：`｜｜DSML｜｜`（U+FF5C 全角竖线）标记、`<thinking>` / `</thinking>`、`<返璞归真>`。
- 只对 agent-loop 请求生效（请求信封带 tools）；后台调用（标题、摘要）不动。
