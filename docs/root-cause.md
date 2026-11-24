# Why a reply sometimes stops halfway

This documents the failure this plugin exists for. It is the record of an
investigation into a DSH install whose assistant messages kept ending after a
sentence or two, usually with a "continue" button and sometimes with a bubble
containing nothing but `</｜｜DSML｜｜ calls>` or `<thinking> </thinking>`.

Everything below was read out of the harness sources and out of the persisted
session logs of that install, not inferred from behaviour.

## Symptom

A turn does not hang and nothing throws. The assistant message is committed, the
turn is reported `completed`, and the UI offers "continue". The user reads it as
"the model froze mid-answer", but the harness believes the model finished
speaking.

## The chain

```
relay (OpenAI- or Anthropic-shaped gateway in front of DeepSeek)
  └─ model emits native tool markup  ｜｜DSML｜｜ invoke / parameter / calls
     └─ relay cannot parse it, so it forwards the brackets as plain text
        └─ pi-ai maps "completed" → stopReason "stop"
           └─ dsh-llm assembles one text block, zero tool calls
              └─ agent-loop: toolCalls.length === 0  ⇒  { kind: "completed" }
                 └─ UI: finished, with a "continue" button
```

Four layers each do something locally reasonable; only the combination is wrong.

### 1. The relay degrades instead of failing

The gateway receives DeepSeek's private tool syntax in the text channel. It has
no parser for `｜｜DSML｜｜` (U+FF5C fullwidth bars), so the markup stays in the
text and the stream still terminates as a normal completion. A protocol
translation failure is reported as success.

Observed residues, byte-for-byte from the session logs:

| residue | length | shape |
| --- | --- | --- |
| the three closing tags | 60 chars | `  </｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>` |
| the last closing tag | 19 chars | `  </｜｜DSML｜｜ calls>` |
| an empty reasoning pair | 23–24 chars | `\n<thinking> </thinking>\n` |

The opening tags and the arguments never arrive: only the closing brackets
survive. That is why the message has no tool call at all rather than a malformed
one.

### 2. `dsh-llm-pi-ai` only rejects a *blockless* stop

`node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js`, `mapStopReason`:

```js
case "stop":
  if (message.content.length === 0) {
    return { kind: "error", failure: { message: `model "…" returned a completed response with no content`, code: EMPTY_RESPONSE_CODE } };
  }
  return { kind: "stop" };
```

The guard counts content *blocks*, not their contents. One residue block makes
`content.length` 1, so the response passes as a legitimate answer. This is the
single narrowest point in the chain and the one worth widening upstream.

### 3. `dsh-agent-loop` reads "no tool call" as "turn over"

`node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js`:

```js
if (finish.kind === "max-tokens") return { kind: "max-tokens" };
const toolCalls = message.content.filter((block) => block.type === "tool-call");
if (toolCalls.length === 0) return { kind: "completed" };
```

Correct for a model that means to stop; indistinguishable from a model whose
tool call was swallowed upstream.

### 4. Nothing in the harness recognises the markup

A recursive scan of all 13,623 `.js`/`.mjs`/`.cjs`/`.ts`/`.json` files under the
DSH application tree for `｜｜`, `DSML`, `tool▁call` and `▁calls▁` returns zero
hits. No layer strips, parses, or sanitises these tokens — they are delivered to
the UI as body text, which is why the user sees them.

## Measurements from one install

Across 35 sessions, 4,573 assistant messages and 210 turns:

| signal | count |
| --- | --- |
| messages whose text or reasoning carried `｜｜DSML｜｜` | 40 / 52 |
| … that had no tool call at all | 29 of 40 |
| … inside a turn reported `completed` | 34 of 40 |
| … that were the last step of their turn | 29 of 40 |
| turns ending `completed` / `aborted` / `error` / `max-tokens` / `interrupted` | 152 / 37 / 17 / 2 / 2 |

Rate by model route:

| route | messages | with residue | rate |
| --- | --- | --- | --- |
| `ds` / `deepseek-v4.1-flash` | 2,779 | 60 | 2.16% |
| `ds` / `deepseek-v4.1-flash-1017` | 1,719 | 10 | 0.58% |
| `ds` / `deepseek/deepseek-v4.1-flash` | 77 | 0 | 0% |

Every message came from the same relay provider `ds`; there was no
officially-routed traffic on that machine, so the table compares relay routes
with each other, not the relay against a direct connection.

The cleanest single instance, from session `894cfb30`, turn 8:

```
[step 28] text(48 chars "…把实验二的报告构建器复制过来：") + tool-call(pwsh)   stopReason=toolUse
[step 29] text(60 chars "  </｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>")
                                                                              stopReason=stop
          tool calls = 0
[turn/end] {"kind":"completed"}
```

Step 28 is a normal step that used a tool. Step 29 is the model's next tool call
arriving with its opening tag eaten, so the harness sees a step that said
"`</｜｜DSML｜｜ calls>`" and stopped.

## Switching protocol does not fix it

Moving the same relay from `openai-responses` to `anthropic-messages` changed the
residue, not the outcome:

| | `openai-responses` | `anthropic-messages` |
| --- | --- | --- |
| residue | DSML closing tags | `<thinking> </thinking>` |
| messages with literal `<thinking>` | 1,206 / 4,578 (26.3%) | 44 / 304 (14.5%) |
| closing steps that were markup-only | 13 | 2 |

Both protocols guard "the stream ended without a stop reason" identically
(`stopReason === "pending"` ⇒ throw), and both map a legitimate end-of-turn to
`stop`. A stop carrying only markup is valid in either shape, so neither adapter
catches it.

The `anthropic-messages` path adds a second way to lose the reasoning channel:
`@earendil-works/pi-ai/dist/api/anthropic-messages.js` downgrades a `thinking`
block that has no `signature` into a plain `text` block when replaying history.
The model then sees its own reasoning as ordinary prose mentioning `<thinking>`,
which is consistent with the empty `<thinking> </thinking>` pairs appearing
immediately afterwards.

One turn on this route degenerated differently: 61,513 characters ending in
`max-tokens`, of which `</返璞归真>` repeated 5,117 times. That tag appears
nowhere in the request — the model invented it and looped. That one is a
repetition trap that ends in `max-tokens`, so the guard still leaves it alone
(truncation is a real answer). Its sibling is handled: see
[the 255-pair flood](#the-255-pair-flood) below.

## A wider sample: 0.5.0 measurements

The numbers above came from 35 sessions of one route. Re-running the same
extraction over **110 sessions / 11,946 assistant messages** (all routes, all
projects on the machine) changed the picture in two ways.

First, residue is far more common than "empty reply" suggests:

| signal | count |
| --- | --- |
| messages whose text or reasoning carried `｜｜DSML｜｜` / `<thinking>` / `<返璞归真>` | 2,598 (21.7%) |
| … that also contained a real tool call | 2,474 |
| … that contained **no** tool call | 124 |

Second — and this is the part that shapes the 0.5.0 judgements — of those 124
messages with no tool call:

| shape | count | verdict |
| --- | --- | --- |
| markup only, no prose at all | 18 | genuinely broken, already caught in 0.4.0 |
| prose containing a whole abandoned tool call | 9 | genuinely broken, **missed by 0.4.0** |
| text stuck inside an unclosed `<thinking>` | 19 (+1 where the tag itself is mangled) | mixed — see below |
| ordinary prose | 77 | **must be preserved** |

An earlier pass over a 130-message superset, counting by feature rather than by
shape, found `｜｜DSML｜｜invoke` in 43 messages that were **correct answers**, plus
9 with a bare `<parameter name=` and 1 with an escaped `:parameter&gt;`. Those two
views disagree on totals because they bucket differently; the load-bearing fact
they agree on is that a large fraction of markup-bearing messages are healthy.

### Position, not presence

What actually separates the broken ones is **where** the markup sits:

- **tail-dangling** — the last thing in the message is a tag, with nothing but
  punctuation after it. The cleanest example is the user-visible one, 159
  characters: `<thinking> </thinking>\n发现两个 Orca 配置目录：…看 daemon.log。\n\n\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>`
  — prose that stops mid-explanation, followed by the leftover envelope of a
  tool call that never got its body.
- **head-first** — the very first thing is a tag, before any prose at all, which
  means the relay dropped the text and forwarded only the parameter block.
- **unclosed call** — prose, then `<parameter name=…` and never a `</parameter>`;
  the model started composing a call and the stream died inside the arguments.

`HEAD_WINDOW` is 40 characters, and that number is load-bearing. The two widest
head-first failures in the corpus put their first tag at offsets 65 and 71, while
correct answers that quote a tag put theirs at 25 and 16. Windows of 80, 120 and
300 were tried and every one of them started eating correct answers; 40 is the
only width that separates the two populations on this corpus. It also means the
65-offset sample is a known miss — widening the window to catch it costs more
than it gains.

### The 255-pair flood

`session-36e33bf4-8cb8-4b18`, turn 3 step 3: 255 consecutive
`<thinking> </thinking>` pairs, 6,120 characters, `stop`, no tool call. Under
0.4.0 this was caught — but only after the model had spent the whole generation
producing it. 0.5.0 interrupts the upstream stream at the 12th empty pair, so the
step fails in a fraction of the time.

### Where `thinkingLeak` is risky, and why it ships off

One 2,089-character message is a **fully correct answer** welded into an unclosed
`<thinking>` because the closing tag was lost. Its sibling failures are 15–164
characters of a fragment (`<thinking>I should look at composeEntries`). Length is
the only separator available, so the judgement is capped at 400 characters and
ships disabled.

### Regression against the real corpus

`regress.mjs` replays every sample through the plugin's public `apply()`,
mounting a stub context — no internal functions, so the measurement cannot drift
from the ship. Of 128 samples:

```
pass -> pass            58   correct answers, all preserved
pass -> TRANSPORT       23   all verified by hand as real failures
fail -> EMPTY_RESPONSE  18   all real failures
fail -> TRANSPORT        4   all real failures
fail -> pass             6   correctly left alone
review -> pass          18   correct answers, preserved
review -> TRANSPORT      1   real failure
```

2 known misses out of 128, both understood: `len=51472` (residue at offset 65,
outside `HEAD_WINDOW`) and `len=645` (no tag left in the tail window — only the
command text remains). Zero false positives.

## A third failure shape: the call is swallowed, not mangled

Everything above is one family: the markup reaches the client. 0.6.0 came from a
screenshot that had **no markup in it at all** — a lone line, "读 L4320-4429 区间和
L2667 附近（main）。", and a `继续` button.

The session is `--D-WORKSPACE.SUN-subagent--/session-43af9a73-…`, turn 53:

```
step 1..6   blocks = reasoning + text + tool-call   tools = 1   stopReason = "toolUse"
step 7      blocks = reasoning + text               tools = 0   stopReason = "stop"     ← the screenshot
turn/end    reason = {"kind": "completed"}
```

Step 7's 270 characters explain the situation: the relay kept the final
`<｜｜DSML｜｜tool_calls>` block **out of the transcript entirely**. What survived is
the sentence that introduced it, followed by the three blank lines where the block
should have been. No residue exists, so the position judgements of 0.5.0 all
passed it through — replayed through `apply()`, `step 7` keeps
`{"kind":"stop"}` and logs nothing.

This shape is invisible to every check that looks for leftover markup. The only
evidence left is **structural**: the model spent six steps calling tools, then
ended the turn on a sentence that announces the seventh call and never made it.

### What the corpus says

115 sessions, 525 turns, **381 steps** that called a tool earlier in the same turn
and then finished on text alone. The overwhelming majority are legitimate — asking
whether to go on, closing out, reporting a decision. Splitting by reply length:
49 under 400 characters, 120 between 400 and 1,500, 211 at 1,500 or more. Only
1 + 10 + 33 of them end in a question mark.

Filtering for "the last non-empty line is a bare announcement of an action" gives
**10 real failures and zero false positives**, including `Let me run it.`,
`Run both.`, `写测试。`, `先改 withTimeout。`, `先看进程启动时间。`,
`确认后我就开始写。` and the screenshot's own line. All ten share a second
property: each wrote at least 143 characters of prose before the last line.
Every false positive found while tuning was short — `先读一下配置。` is 7
characters — which is why the judgement requires the reply to be at least 100
characters long before the last line is even read.

### Why `endsInNarration` reads exactly one line

`NARRATION_MAX_LINE = 60`, an action verb at the start, no comma or semicolon, no
`HANDS_BACK` phrasing ("要不要我 / 需要我 / 吗"), and the 100-character floor. Two
shapes are deliberately missed: two-clause announcements ("然后读 A，再读 B。")
and single clauses that contain a comma. Every attempt to widen the rule far
enough to catch those started catching normal explanatory endings, which is a
worse trade than a miss — a miss costs one `继续` click, a false positive throws
away a correct answer.

### A false positive this shipped with, and the fix

The first build flagged a **1,625-character correct answer** (`t1/s138`) that
discusses the `thinkingLeak` design and quotes `` `<parameter name=…` `` inside a
table cell without ever closing it. `hasUnclosedCall` counted openers minus
closers, saw zero closers, and treated the remaining 1,197 characters of prose as
an unclosed parameter body.

The fix keeps the judgement but requires the body to still *look like* a
parameter body: if a sentence-ending punctuation mark (`。！？`) or a blank line
appears after the last opener, prose has resumed and the call did not break off
mid-write. Compared against 12 candidate samples, this changed exactly one verdict
(true → false) and dropped no real residue.

### Regression, 0.6.0

```
regress-narration.mjs   392 abandoned-loop samples  -> 56 rewritten, 0 false positives
regress.mjs             139 residue samples         -> 0 false positives, 2 known misses

The corpus grows as sessions accumulate: the 0.5.0 run above saw 128 residue
samples and an earlier narration run saw 387 abandoned loops. The extra samples
landed in the same buckets, so both verdicts are unchanged.
```

`node --test`: 91 tests, all passing (up from 71).

## What this plugin changes

It intercepts the one funnel every call passes through — the `llm/stream`
waterfall — and measures the attempt as it streams. There are four judgements on
the finished text and two on the stream itself.

On a `stop` with no tool call observed:

```js
// 1. nothing but markup
{ kind: "error", failure: { code: "EMPTY_RESPONSE", message: "…no usable content (protocol markup only)" } }
// 2/3. residue at the tail, head, or an unclosed parameter block
{ kind: "error", failure: { code: "TRANSPORT", message: "…stops on protocol markup" } }
// 4. the reply ends on a bare announcement of a call that was never made
{ kind: "error", failure: { code: "TRANSPORT", message: "…announced the next tool call and then ended the turn" } }
```

While streaming: no chunk for 90 s ⇒ `TIMEOUT`; stream ends with no `finish` chunk
⇒ `TRANSPORT`; 12 empty `<thinking> </thinking>` pairs with nothing else ⇒
`EMPTY_RESPONSE`, interrupting the upstream iterator rather than draining it.

All three codes are already in `DEFAULT_RETRYABLE_CODES` of `@deepseek-ai/dsh-llm`,
so `@deepseek-ai/dsh-llm-retry` retries the step with backoff (5 attempts, 500 ms
initial delay, 10 s cap, 10% jitter) instead of ending the turn on nothing. A
custom code would never be retried, which is why the new judgements reuse these
three rather than inventing names.

What keeps ordinary replies safe: the finish must be `stop`, no tool call may
have been observed, and each judgement looks at a **position** (last 400
characters, first 40 characters, an unclosed `<parameter>` with more than 80
characters of body after it) rather than at the mere presence of a tag. A
one-word answer, a single `?`, prose that mentions a tag, and a correctly closed
parameter block quoted in a code fence all pass through untouched. `max-tokens`
is left alone because a truncated answer is a real answer and already surfaces as
its own visible outcome. Background calls that declare no tools (session titles,
compaction) are skipped. The announcement judgement only reads the **last line**,
and only in a reply that already spent 100 characters getting there, so an answer
that offers to continue, closes out, or answers in one word is untouched.

## Why the switch is volatile

`@deepseek-ai/dsh-settings` decides whether a plugin has a settings namespace at
all, and it does so by filtering the plugin's exported schema:

```js
// dsh-settings/lib/index.js, describe()
const schema = this.schema(entry);
if (schema === void 0 || entry.fiber === void 0 || entry.fiber.runtime === null || entry.fiber.state !== 2) return [];
const form = volatileForm(schema);
if (form === void 0) return [];
```

```js
// dsh-settings/lib/index.js, volatileForm()
if (schema.meta.volatile) return plainSchema(schema);
if (schema.type === "object") {
  const dict = Object.fromEntries(…only fields whose nearest ancestor is volatile…);
  return Object.keys(dict).length === 0 ? void 0 : z.object(dict);
}
```

A schema with no volatile field therefore yields `undefined`, the namespace is
dropped, and the browser half's `configForms.whileServed([…])` callback never
runs. The card does not appear, and nothing is logged — the failure is silent.

`.volatile()` also changes how the value is delivered: the plugin receives a
frozen `{ get() }` reference (`createVolatile` in `@deepseek-ai/cosmokit`) rather
than a boolean, so `config.enabled === false` is never true. `lib/index.js`
handles both shapes and re-reads the flag per request, which is what lets the
switch take effect without remounting.

## What would actually fix it upstream

1. **The relay**, returning an error when it cannot translate a tool call instead
   of forwarding the brackets as text. This is the root cause.
2. **`dsh-llm-pi-ai`**, widening `content.length === 0` to "no content beyond
   protocol markup", which would catch every third-party route at once.
3. **A direct provider route** (`deepseek-official`, which speaks structured
   `tool_use` over Anthropic Messages and has no text-parsing step at all),
   removing the translating relay from the path.

This plugin is a client-side mitigation for installs that cannot change 1 or 3
yet. It does not repair the relay, does not strip markup from delivered text,
does not parse the markup back into a tool call, and does not catch every
residue position.
