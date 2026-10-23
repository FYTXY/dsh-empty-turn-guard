# dsh-empty-turn-guard

**English** | [简体中文](./README.zh-CN.md)

A small [DSH (DeepSeek-Harness)](https://github.com/deepseek-ai) plugin for one
specific failure: the model replies with **nothing but leaked protocol markup** —
no prose, no tool call — and the harness treats that as a finished turn. This
plugin reclassifies it as a **retryable error** so the step is retried instead of
silently ending the turn.

It is a DSH **bundle** (a package with its own `cordis.patch.yml`) and installs
without touching any DSH file.

## Features

- **Catches the "half an answer" turn.** When a reply ends with only
  `</｜｜DSML｜｜ calls>`, `<thinking> </thinking>`, or leftover punctuation, the
  step is retried with backoff instead of being committed as an answer.
- **Two settings entry points.** A dedicated tab under **Settings → Built-in
  plugins → Empty-turn guard**, and the same card on the sidebar **Plugins**
  panel. Both drive the same switch.
- **Cannot false-positive on real replies.** Three conditions must hold at once:
  the finish is `stop`, no tool call was observed, and the text is empty after
  markup removal. A one-word answer, a lone `?`, or prose that merely mentions a
  tag passes through untouched.
- **Leaves truncation alone.** `max-tokens` is a real answer cut short and already
  surfaces as its own visible outcome, so it is not touched.
- **No dependencies at runtime.** Host half imports only a schema library; the
  browser half is a hand-written bundle with no build step.
- **Logs the length, never the text.** Diagnostics carry `text=24ch`, so model
  output does not reach log files through this plugin.

## Install

```sh
# straight from GitHub (works today)
dsh plugin --profile <your-profile> add github:FYTXY/dsh-empty-turn-guard

# from a local checkout, for development
dsh plugin --profile <your-profile> add link:/absolute/path/to/dsh-empty-turn-guard

# from npm — not published yet, this line will fail with E404 for now
dsh plugin --profile <your-profile> add dsh-empty-turn-guard
```

`dsh plugin … add` forwards its arguments to pnpm, so GitHub shorthands, tags and
branches work too (`github:FYTXY/dsh-empty-turn-guard#v0.4.0`).

Restart DSH, then open **Settings → Built-in plugins → Empty-turn guard** and
turn the switch on.

<details>
<summary>Installing without the CLI</summary>

1. Put this directory somewhere stable, e.g. `~/.dsh/plugins/dsh-empty-turn-guard`.
2. Link it into the profile's `node_modules` (symlink or Windows junction).
3. In the profile's `package.json`, add the package name to **both**
   `dependencies` and the `dsh.profile.bundles` array.
4. Restart DSH.

Do not insert a bare path row into `cordis.patch.yml` instead: that mounts the
plugin as a plain module rather than a bundle, and the settings card will not
appear.

With a `link:` or manual install, `@deepseek-ai/schemastery` resolves from the
copy DSH already ships. If Node reports `ERR_MODULE_NOT_FOUND:
@deepseek-ai/schemastery`, point at that copy:

```powershell
New-Item -ItemType Junction -Path ".\node_modules\@deepseek-ai\schemastery" `
  -Target "$env:USERPROFILE\.dsh\profiles\<profile>\node_modules\@deepseek-ai\schemastery"
```

A GitHub install handles this through pnpm and needs no extra step.

</details>

## Configuration

### 1. The switch

Both entry points write the same value — the package's entry in the profile's
`dsh.profile.bundles` array — so either works:

| Entry point | What it shows |
| --- | --- |
| Settings → Built-in plugins → **Empty-turn guard** | The plugin's own tab: the switch, what it currently does, and save / discard |
| Sidebar → **Plugins** panel | The same switch on the bundle's card |

Turning it **off** unloads the plugin and restores the untouched `llm/stream`
chain, which brings the silent half-turn back. Turning it **on** reloads the
guard. Both take effect without reinstalling.

The row-level toggle for this plugin's row is greyed out on the Plugins panel.
That is expected: DSH only enables or disables *rows* through the profile's own
patch file, and this plugin's row comes from the bundle's own `cordis.patch.yml`.
The bundle switch is the one that takes effect.

### 2. Disabling it without unloading

To keep the package installed but skip the interception, give the row a config:

```yaml
- id: dsh-empty-turn-guard
  name: 'dsh-empty-turn-guard'
  config:
    enabled: false
```

`enabled` is a volatile field, so it arrives as a live reference rather than a
frozen value; the guard re-reads it on every request and the settings switch
applies to the next model call with no restart.

### 3. Verifying it is running

In the host log (`%APPDATA%\DSH Desktop\logs\host\dsh-<date>.log` on Windows,
`~/.config/DSH Desktop/logs/host/` on Linux):

```
[dsh-empty-turn-guard] empty-turn-guard: mounted (markup-only stops become EMPTY_RESPONSE retries)
```

And when a markup-only stop is actually caught:

```
[dsh-empty-turn-guard] rewriting an empty stop (text=24ch) into EMPTY_RESPONSE
```

An `llm/retry` / `llm/retry-started` event usually follows — that is the retry
running.

## How it works

```
LLM call
  └─ llm/stream  ◀── this plugin wraps here (global, prepended)
     └─ adapter stream (openai-responses | anthropic-messages)
        └─ chunks: block-start / text-delta / block-end / usage / finish

on finish:
  reason.kind === "stop"
    AND no tool call observed
    AND stripMarkup(text) === ""        ⇒  rewrite to error EMPTY_RESPONSE
  otherwise                             ⇒  yield the chunk untouched

error EMPTY_RESPONSE
  └─ @deepseek-ai/dsh-llm-retry: in DEFAULT_RETRYABLE_CODES
     └─ retries the step (5 attempts, 500 ms initial, 10 s cap, 10 % jitter)
```

`llm/stream` is the single funnel every model call passes through, and the
waterfall lets a listener wrap the provider's chunk stream instead of reacting
after the fact. Rewriting the `finish` chunk — rather than editing text or
injecting a message — keeps the conversation history clean and reuses the retry
machinery the provider already declares.

Two filters keep the interception narrow. Requests that declare no tools are
skipped, because background calls (session titles, compaction) stream the same
way and an empty reply there is expected. `max-tokens` is skipped because a
truncated answer is a genuine answer.

The failure this targets, the measurements behind it, and why switching protocol
does not help are documented in **[docs/root-cause.md](docs/root-cause.md)**.

## Compatibility

- **DSH `0.2.0-rc.2`** (verified on this release).
- **Node.js >= 22.**
- Uses only existing seams: the `llm/stream` waterfall and the `EMPTY_RESPONSE`
  error code. No DSH file is modified.
- `@deepseek-ai/schemastery` is a **peer dependency** supplied by DSH.
- The schema keeps a `.volatile()` field on purpose. `@deepseek-ai/dsh-settings`
  drops any namespace whose schema has none — silently — and the settings card
  would vanish. See the note at the end of
  [docs/root-cause.md](docs/root-cause.md).

## Non-goals

- **Does not repair the relay.** The markup still reaches the message body; it
  just no longer pretends to be a finished turn.
- **Does not sanitise history.** Messages already on disk keep their residue.
- **Does not handle degenerate repetition.** A reply that loops until
  `max-tokens` already shows up as its own visible outcome.
- **Does not guarantee the retry succeeds.** If the relay only ever returns
  residue, the retries are exhausted and you get a clear error — still better
  than a silent half-answer.

## Development

There is no build step. `lib/index.js` and `lib/client.js` are the shipped
artifacts.

```sh
npm run check   # node --check on both entry points
npm test        # node --test over tests/
```

`lib/client.js` is a hand-written ModuleLoader bundle because the browser runner
loads it by evaluating `window.__ModuleLoader__.load({ id, factory })`. It may
require only `react`, `react/jsx-runtime` and
`@deepseek-ai/dsh-client-ui-primitives`. Do not introduce a bundler for it.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the review bar, and
[SECURITY.md](SECURITY.md) for the plugin's security boundaries.

## Repository Layout

```
dsh-empty-turn-guard/
├── lib/index.js           # host half: the llm/stream guard (no runtime deps)
├── lib/client.js          # browser half: the settings card + plugins card
├── cordis.patch.yml       # bundle patch: mounts the plugin row
├── package.json           # dsh.bundle.patch and dsh.client point at the above
├── tests/                 # node:test suites for both halves
│   ├── guard.test.mjs
│   └── client-bundle.test.mjs
├── docs/root-cause.md     # the failure this plugin targets, with evidence
├── .github/workflows/     # CI: Node 22 + 24 on Linux and Windows
├── CHANGELOG.md
├── CONTRIBUTING.md
├── SECURITY.md
└── LICENSE
```

## Uninstall

```sh
dsh plugin --profile <your-profile> remove dsh-empty-turn-guard
```

Or turn the switch off in **Settings → Built-in plugins → Empty-turn guard**.

## License

[MIT](LICENSE)
