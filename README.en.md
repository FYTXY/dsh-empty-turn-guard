# dsh-empty-turn-guard

[中文](./README.md) | **English**

A small plugin for [DSH (DeepSeek Harness)](https://github.com/deepseek-ai): when a model reply ends up containing **nothing but protocol residue — no prose and no tool call** — it is rewritten into a **retryable error** instead of being accepted as "the model finished normally".

Once installed it gives you **two** switch locations:

- **Settings → Built-in plugins → "Empty turn guard"**: its own tab with a switch, a description, and Save / Discard.
- **Plugins** sidebar panel: the same card and the same switch (it edits `dsh.profile.bundles`).

---

## The problem it solves

Symptom: a reply stops halfway. The bubble may hold

- half a sentence,
- or only markers such as `</｜｜DSML｜｜ parameter>` `</｜｜DSML｜｜ invoke>` `</｜｜DSML｜｜ calls>`,
- or only an empty `<thinking> </thinking>` pair,

followed by a "continue" button. Clicking it resumes the work, but whatever that step was supposed to do has already been lost.

Root cause — not a DSH crash, but "an empty turn judged as a normal completion":

1. A translating relay hands the model's **native tool-call markup** back as plain text and still reports an ordinary `stop`. Nothing in DSH understands `｜｜DSML｜｜` or `<thinking>`, so it is rendered as prose.
2. `@deepseek-ai/dsh-agent-loop` decides a turn is over by **counting tool calls only**: `toolCalls.length === 0 → { kind: "completed" }`.
3. The empty-content guard in `@deepseek-ai/dsh-llm-pi-ai` only checks **the number of content blocks**: `message.content.length === 0`. One residue block makes it non-zero, so the guard passes.

So "one residue block" is persisted as a complete reply, and the UI honestly shows "completed" plus a "continue" button.

This plugin wraps the `llm/stream` waterfall, measures what the attempt actually produced, and rewrites the finish reason into an `EMPTY_RESPONSE` error when all three hold:

1. the finish reason is `stop` (not `max-tokens`);
2. the attempt produced no tool call at all;
3. stripping protocol residue (`｜｜DSML｜｜` markers, `<thinking>`/`</thinking>`, `<返璞归真>`) and whitespace from the text channel leaves **nothing**.

`EMPTY_RESPONSE` is in DSH's default retryable set, so `@deepseek-ai/dsh-llm-retry` **retries the step with backoff** (5 attempts by default). A successful retry is invisible; only persistent failures surface as a real error instead of a fake success.

---

## Install

### From npm (recommended for sharing)

```bash
dsh plugin --profile <your-profile> add dsh-empty-turn-guard
```

Then open DSH → **Settings → Built-in plugins → "Empty turn guard"** (or the **Plugins** sidebar panel) and flip the switch on.

### From GitHub (use this until it is published to npm)

```bash
dsh plugin --profile <your-profile> add github:FYTXY/dsh-empty-turn-guard
```

`dsh plugin ... add` forwards its arguments to pnpm, so the pnpm GitHub shorthand, `git+https://...`, tags and branches all work (e.g. `github:FYTXY/dsh-empty-turn-guard#v0.3.1`).

### From a local checkout

```bash
git clone https://github.com/FYTXY/dsh-empty-turn-guard.git dsh-empty-turn-guard
dsh plugin --profile <your-profile> add link:<absolute path to the directory>
```

### Fully manual

1. Put this directory anywhere, e.g. `~/.dsh/plugins/dsh-empty-turn-guard`.
2. Symlink / junction it into the profile's `node_modules`.
3. In the profile `package.json`: add the package name to `dependencies` **and** to the `dsh.profile.bundles` array.
4. Restart DSH.

> Do not fall back to inserting a bare file-path row into `cordis.patch.yml`: that does not make it a bundle, so **there is no switch in Settings**.

> When installing via link or by hand, the `@deepseek-ai/schemastery` dependency has to resolve to the copy the profile already has. If node reports `ERR_MODULE_NOT_FOUND: @deepseek-ai/schemastery`, junction it in from this package:
>
> ```powershell
> New-Item -ItemType Junction -Path ".\node_modules\@deepseek-ai\schemastery" `
>   -Target "$env:USERPROFILE\.dsh\profiles\<profile>\node_modules\@deepseek-ai\schemastery"
> ```
>
> A normal npm / GitHub install lets pnpm install it, so this step does not apply.

---

## Enabling / disabling from Settings

There are two entry points; both edit the same thing (the profile `package.json`'s `dsh.profile.bundles`) and hot-reload:

**Entry 1: Settings → Built-in plugins → "Empty turn guard"**

This is the plugin's own config page (the client half `lib/client.js` registers into `settings.plugins.tab`): a switch, a one-line status, and Save / Discard.

**Entry 2: the "Plugins" sidebar panel**

DSH's plugin manager lists every selected bundle as a card with a switch.

Either switch does the same thing:

- **off**: the plugin is not loaded; `llm/stream` is untouched (markup-only turns silently complete again);
- **on**: the guard is mounted again.

> Note: the switch on this plugin's individual **row** in the plugin manager may appear greyed out. That is expected — DSH only lets the profile's own patch file toggle rows, and this plugin's row comes from the `cordis.patch.yml` shipped inside the package, so the **bundle** switch is the one that counts.

You can also disable it at the config level while keeping the package selected:

```yaml
- id: dsh-empty-turn-guard
  name: 'dsh-empty-turn-guard'
  config:
    enabled: false
```

The plugin still loads but returns immediately without intercepting anything. Flipping the switch in Settings needs **no restart** — `enabled` is a volatile field, so the runtime hands the plugin a live reference and every request re-reads it.

> One trap worth recording if you build a configurable settings page of your own: every `Config` field must be marked `.volatile()` (e.g. `z.boolean().default(true).volatile()`). `@deepseek-ai/dsh-settings` filters the schema through `volatileForm(schema)`, which keeps only volatile fields and returns `undefined` when there are none — the row is then skipped entirely, and **Settings silently shows nothing** while the host logs no error and the plugin mounts fine. The official `dsh-agent-loop` and `dsh-agent-default-model` packages declare their fields the same way.

---

## Verifying it works

Host log (`%APPDATA%\DSH Desktop\logs\host\dsh-<date>.log`):

```
[empty-turn-guard] empty-turn-guard: mounted (markup-only stops become EMPTY_RESPONSE retries)
```

When it actually catches one:

```
[empty-turn-guard] rewriting an empty stop (text=23ch) into EMPTY_RESPONSE
```

usually followed by `llm/retry` / `llm/retry-started` events.

---

## Compatibility

- Verified on DSH `0.2.0-rc.2`.
- Uses existing DSH facilities only (`llm/stream`, the `EMPTY_RESPONSE` code); it patches no DSH file.
- Node.js >= 22.

## Non-goals

- It does **not** fix the relay: residue still appears in the text channel, it just no longer passes as a completion.
- It does **not** rewrite persisted history.
- It does **not** handle `max-tokens` degeneration loops (DSH already surfaces those as a visible `max-tokens` outcome).
- It does **not** guarantee a retry succeeds: a relay that keeps returning residue will exhaust retries and raise a clear error — still better than a silent half-reply.

## Uninstall

```bash
dsh plugin --profile <your-profile> remove dsh-empty-turn-guard
```

or just flip the switch off in **Settings → Built-in plugins → "Empty turn guard"**.

## License

MIT
