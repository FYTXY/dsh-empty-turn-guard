# dsh-empty-turn-guard

**English** | [简体中文](./README.zh-CN.md)

A small [DSH (DeepSeek-Harness)](https://github.com/deepseek-ai) plugin for one
family of failures: the model's reply **is not a usable answer** — it stops
halfway into leaked protocol markup, the stream goes quiet and never finishes, it
loops on empty `<thinking>` pairs, or it hands back a chain of thought instead of
a reply. The harness would treat any of these as a finished turn; this plugin
reclassifies them as **retryable errors** so the step is retried instead of
silently ending.

It is a DSH **bundle** (a package with its own `cordis.patch.yml`) and installs
without touching any DSH file.

## Features

- **Catches the "half an answer" turn.** Measured over 11 946 assistant messages,
  the common shape is *not* an empty reply — it is prose that stops and is
  followed by `</｜｜DSML｜｜ invoke>` / `</｜｜DSML｜｜ calls>`. That is what the user
  sees as "the output froze halfway". Caught and retried.
- **Catches the reply that opens with markup.** When a relay drops the prose and
  emits only the parameter block, the reply never starts being an answer.
- **Catches the call that never closes.** Prose, then `<parameter name=…` with no
  `</parameter>`: the model began composing a call and the stream ended inside it.
- **Catches the announcement with nothing behind it.** Six tool calls run, then the
  reply says what it is about to do — "读 L4320-4429 区间和 L2667 附近（main）。",
  "Let me run it." — and ends the turn. Nothing ran and nothing failed, so the step
  is recorded as completed. The relay swallowed the call block; judged from the
  final line only, and only in a reply long enough to have been building to it.
- **Catches a stalled stream.** No chunk for 90 s becomes `TIMEOUT`; a stream that
  ends without a `finish` chunk becomes `TRANSPORT`. Text that already arrived is
  still delivered to the transcript.
- **Cuts repetition off early.** Twelve empty `<thinking> </thinking>` pairs with
  nothing else aborts the stream instead of paying for the whole loop — one
  measured case emitted 255 pairs before ending on its own.
- **Evidence-based, so it does not eat real replies.** The judgement is about
  *where* a marker sits, not whether one exists: 43 of the 130 measured
  residue-bearing messages were correct answers that **quote** the markup while
  explaining the bug. All of them pass untouched, including a 1 750-character
  report and a 2 089-character answer wrapped in an unclosed `<thinking>`.
- **Six switches, no numbers.** Master switch plus one per judgement; the
  thresholds are constants so a settings page can never be tuned into false
  positives.
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
branches work too (`github:FYTXY/dsh-empty-turn-guard#v0.6.0`).

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

### 1. The six switches

All of them live in the plugin's own tab under **Settings → Built-in plugins →
Empty-turn guard**, and the master switch is also on the bundle's card in the
sidebar **Plugins** panel. Thresholds are not exposed: they are constants in
`lib/index.js`, because every one of them was chosen from measured samples and a
number field invites tuning into false positives.

| Switch | Default | What it treats as a failed turn |
| --- | --- | --- |
| `enabled` | on | Master switch. Off = unload the guard entirely. |
| `toolCallResidue` | on | The reply ends in markup, opens with markup, or walks into a `<parameter>` block it never closes. |
| `narrationStop` | on | The reply ends on a bare one-clause announcement of the next call ("读 L4320-4429 区间和 L2667 附近（main）。", "Let me run it.") and then stops, so nothing ran. Only the last line is read, and only when the reply spent at least 100 characters getting there. |
| `streamStall` | on | No chunk for 90 s (`TIMEOUT`), or the stream ends without a `finish` chunk (`TRANSPORT`). |
| `repetition` | on | Twelve empty `<thinking> </thinking>` pairs with nothing else in the text. Aborts early instead of waiting for the loop to end. |
| `thinkingLeak` | **off** | A short reply (≤ 400 characters of prose) that is entirely inside an unclosed `<thinking>`. Off by default: real samples exist where a complete, correct answer lost its closing tag, and only length separates the two. |

Turning `enabled` off unloads the plugin and restores the untouched `llm/stream`
chain, which brings the silent half-turn back. The other five are judged per
request, so flipping them applies to the next model call with no restart.

Both entry points write the same value — the package's entry in the profile's
`dsh.profile.bundles` array — so either works:

| Entry point | What it shows |
| --- | --- |
| Settings → Built-in plugins → **Empty-turn guard** | The plugin's own tab: all six switches, what they currently do, and save / discard |
| Sidebar → **Plugins** panel | The master switch on the bundle's card |

The row-level toggle for this plugin's row is greyed out on the Plugins panel.
That is expected: DSH only enables or disables *rows* through the profile's own
patch file, and this plugin's row comes from the bundle's own `cordis.patch.yml`.
The bundle switch is the one that takes effect.

### 2. Disabling a judgement without unloading

To keep the package installed but skip one judgement, give the row a config:

```yaml
- id: dsh-empty-turn-guard
  name: 'dsh-empty-turn-guard'
  config:
    repetition: false
```

Every field is volatile, so it arrives as a live reference rather than a frozen
value; the guard re-reads all switches on every request.

### 3. Verifying it is running

In the host log (`%APPDATA%\DSH Desktop\logs\host\dsh-<date>.log` on Windows,
`~/.config/DSH Desktop/logs/host/` on Linux):

```
[dsh-empty-turn-guard] empty-turn-guard: mounted (broken steps become retryable errors)
```

And when a judgement actually fires — the line names the rule, the discarded
length, and the error code it became:

```
[dsh-empty-turn-guard] rewriting a markup-only stop (text=24ch) into EMPTY_RESPONSE
[dsh-empty-turn-guard] rewriting a tool-call-residue stop (text=159ch) into TRANSPORT
[dsh-empty-turn-guard] rewriting a narration-only stop (text=270ch) into TRANSPORT
[dsh-empty-turn-guard] rewriting a stream-stalled attempt (no chunk for 90000ms) into TIMEOUT
[dsh-empty-turn-guard] rewriting a stream-truncated attempt (no finish chunk) into TRANSPORT
```

An `llm/retry` / `llm/retry-started` event usually follows — that is the retry
running.

## How it works

```
LLM call
  └─ llm/stream  ◀── this plugin wraps here (global, prepended)
     └─ adapter stream (openai-responses | anthropic-messages)
        └─ chunks: block-start / text-delta / block-end / usage / finish

while streaming:
  probe the text so far
    empty-thinking pairs ≥ 12, rest empty   ⇒  abort upstream, error EMPTY_RESPONSE
    no chunk for 90 s                       ⇒  error TIMEOUT
    stream ended with no finish chunk       ⇒  error TRANSPORT

on finish:
  reason.kind === "stop" AND no tool call observed
    stripMarkup(text) === ""                ⇒  error EMPTY_RESPONSE   (markup-only)
    endsInResidue(text)                     ⇒  error TRANSPORT        (hangs on markup)
    startsInResidue(text)                   ⇒  error TRANSPORT        (opens on markup)
    hasUnclosedCall(text)                   ⇒  error TRANSPORT        (never closes it)
    narrationStop && endsInNarration(text)  ⇒  error TRANSPORT        (announced, never called)
    thinkingLeak && isThinkingLeak(…)       ⇒  error EMPTY_RESPONSE   (opt-in)
  otherwise                                 ⇒  yield the chunk untouched

error
  └─ @deepseek-ai/dsh-llm-retry: all three codes are in DEFAULT_RETRYABLE_CODES
     └─ retries the step (5 attempts, 500 ms initial, 10 s cap, 10 % jitter)
```

`llm/stream` is the single funnel every model call passes through, and the
waterfall lets a listener wrap the provider's chunk stream instead of reacting
after the fact. Rewriting the `finish` chunk — rather than editing text or
injecting a message — keeps the conversation history clean and reuses the retry
machinery the provider already declares. A step that fails this way never appends
an `assistant/message`, so the half-written text does not reach the transcript
either.

**Position, not presence.** The whole design turns on one measurement: 43 of the
130 residue-bearing replies in the corpus were *correct answers* that quoted the
markup while explaining this very bug. So a marker existing proves nothing. What
distinguishes a broken reply is that no prose follows the last marker
(`endsInResidue`), that no prose precedes the first one inside the opening 40
characters (`startsInResidue`), or that a `<parameter>` block was opened and never
closed (`hasUnclosedCall`).

The `HEAD_WINDOW = 40` constant is load-bearing: measured false positives appear
at 80, 120 and 300, because the quoted markers in a real answer sit 65–71
characters in.

**The announcement rule reads one line.** `endsInNarration` looks only at the
last non-empty line, and accepts it only if it is a single short clause: at most
60 characters, opened by an action verb, with no comma or semicolon, and no
"shall I / do you want me to / 要不要我" turn-taking. A reply shorter than 100
characters is never judged this way, because "先读一下配置。" is indistinguishable
from a legitimate short answer, while every measured failure spends 143
characters or more on prose before the final line. Two known shapes are missed by
design — a two-clause announcement ("然后读 A，再读 B。") and one that carries a
comma — because widening the rule to reach them starts catching genuine
explanatory closings.

Two filters keep the interception narrow. Requests that declare no tools are
skipped, because background calls (session titles, compaction) stream the same
way and an empty reply there is expected. `max-tokens` is skipped because a
truncated answer is a genuine answer.

**Retry, never parse.** The plugin deliberately does not turn leaked DSML back
into a tool call. A parser that mis-reads one argument executes the wrong
command; a retry only costs a provider round-trip.

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
- **Does not parse the markup back into a tool call.** Deliberate: a parser that
  mis-reads one argument executes the wrong command, which is a worse outcome
  than a retry.
- **Does not sanitise history.** Messages already on disk keep their residue.
- **Does not catch every residue position.** Residue that sits between the 40th
  and 400th character, with prose on both sides, still passes (2 of 139 measured
  samples). Widening the window starts eating correct answers instead — the
  trade-off is documented in `docs/root-cause.md`.
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
