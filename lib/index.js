/**
 * dsh-empty-turn-guard — keep a broken step from silently ending the turn.
 *
 * Why this exists
 * ---------------
 * A translating relay (an OpenAI/Anthropic-compatible gateway in front of a
 * DeepSeek model) may hand the model's *native* tool/thinking markup back as
 * plain text in the text channel, then report an ordinary `stop`. The harness
 * assembles that into an assistant message with zero tool calls, and
 * `@deepseek-ai/dsh-agent-loop` treats "a step that produced no tool call" as
 * "the turn is finished" (`toolCalls.length === 0 → { kind: "completed" }`).
 * The user sees half an answer, or a bubble containing nothing but
 * `</｜｜DSML｜｜ calls>` / `<thinking> </thinking>`, plus a "continue" button.
 *
 * `@deepseek-ai/dsh-llm-pi-ai` only guards the response that has no content
 * blocks at all (`content.length === 0 → EMPTY_RESPONSE`). One leftover markup
 * block makes the length non-zero, so it passes.
 *
 * What this plugin does
 * ---------------------
 * It wraps the `llm/stream` waterfall (the single funnel every LLM call passes
 * through), measures what the attempt actually produced, and — when the stream
 * cannot possibly be a finished answer — rewrites the finish reason into an
 * error whose code is already in the provider's default retryable set, so
 * `@deepseek-ai/dsh-llm-retry` retries the step with backoff instead of ending
 * the turn on nothing.
 *
 * Seven judgements, each independent and independently switchable:
 *
 * | rule              | what it catches                                             | code             |
 * | ----------------- | ----------------------------------------------------------- | ---------------- |
 * | `markup-only`     | a stop whose whole text is protocol residue                  | `EMPTY_RESPONSE` |
 * | `tool-call-residue` | residue hanging off the tail of an otherwise real reply    | `TRANSPORT`      |
 * | `narration-only`  | a reply that stops right after announcing the next tool call | `TRANSPORT`      |
 * | `stream-stalled`  | no chunk arrived for `IDLE_TIMEOUT_MS`                       | `TIMEOUT`        |
 * | `stream-truncated`| the stream ended without ever sending a `finish` chunk       | `TRANSPORT`      |
 * | `repetition`      | the model loops on empty `<thinking>` pairs                  | `EMPTY_RESPONSE` |
 * | `thinking-leak`   | a short reply that is *entirely* unclosed `<thinking>`       | `EMPTY_RESPONSE` |
 *
 * Every code above is one of `DEFAULT_RETRYABLE_CODES` in `@deepseek-ai/dsh-llm`.
 * That is a hard constraint, not a style choice: a custom code would surface an
 * error the retry policy ignores, which turns a silent stall into a loud failure
 * without ever retrying it.
 *
 * Only agent-loop turns are inspected: the request envelope carries the active
 * tool declarations, while background calls (session titles, summaries) send
 * none, and a retry there would only add noise.
 *
 * Non-goals, deliberately:
 *
 * - This does not repair the relay, and does not strip markup from the text
 *   that is delivered.
 * - This does not parse DSML residue back into tool calls. Reconstructing an
 *   argument payload from leaked markup means executing a command nobody wrote
 *   as a tool call; a wrong retry is cheap, a wrong `rm -rf` is not.
 * - This does not treat every message containing the string `DSML` as broken.
 *   Models quote that residue when explaining it to the user, and measured over
 *   130 real residue-bearing messages, "contains a marker" was true of 43
 *   *correct* answers. What separates a broken step is *where* the marker sits,
 *   so the judgement is about position, never mere presence.
 * - A `max-tokens` finish is left alone: it is a real answer cut short, and the
 *   loop already reports it as its own visible outcome.
 */

import z from '@deepseek-ai/schemastery'

/** Cordis plugin name; matches the bundle patch row id and the package name. */
export const name = 'dsh-empty-turn-guard'

/**
 * The settings this plugin exposes under its own namespace.
 *
 * `@deepseek-ai/dsh-settings` decides whether a row has a settings namespace at
 * all by reading `entry.fiber.runtime.Config` (`schema(entry)` in its
 * `SettingsForms`), then filters it through `volatileForm(schema)`, which keeps
 * only the fields whose nearest ancestor is marked volatile and returns
 * `undefined` — dropping the whole namespace — when nothing is left. `.volatile()`
 * is therefore load-bearing: without it the Host never serves the namespace, the
 * browser half's `configForms.whileServed` callback never runs, and the settings
 * card silently never appears.
 *
 * The namespace itself is the row id, so the client half spells
 * `dsh-empty-turn-guard` and finds this schema. Every field is read per request
 * (see `readSwitches`), so flipping one takes effect without a restart.
 */
export const Config = z.object({
  enabled: z
    .boolean()
    .default(true)
    .volatile()
    .description('总开关 / master switch'),
  toolCallResidue: z
    .boolean()
    .default(true)
    .volatile()
    .description('尾部悬挂的工具调用残骸 / retry a reply whose tail is leaked tool-call markup'),
  narrationStop: z
    .boolean()
    .default(true)
    .volatile()
    .description('只说不做（宣告下一步就停） / retry a reply that stops after announcing the next call'),
  streamStall: z
    .boolean()
    .default(true)
    .volatile()
    .description('流卡死与截断 / retry a stream that goes idle or ends without a finish'),
  repetition: z
    .boolean()
    .default(true)
    .volatile()
    .description('空 thinking 刷屏 / cut off a loop of empty thinking pairs'),
  thinkingLeak: z
    .boolean()
    .default(false)
    .volatile()
    .description('思考泄漏（可能误伤） / retry a short reply that is only unclosed thinking'),
})

/**
 * Provider-neutral codes the retry policy already treats as safely repeatable.
 * @see DEFAULT_RETRYABLE_CODES in @deepseek-ai/dsh-llm
 */
const EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE'
const TRANSPORT_CODE = 'TRANSPORT'
const TIMEOUT_CODE = 'TIMEOUT'

/** How long a stream may go without a chunk before it is considered dead. */
const DEFAULT_IDLE_TIMEOUT_MS = 90_000

/**
 * Empty `<thinking> </thinking>` pairs tolerated before the stream is cut.
 * Measured worst case in real sessions: 255 pairs, 6 120 characters, retried
 * only after the whole loop had been generated and billed.
 */
const REPEAT_LIMIT = 12

/**
 * Longest unclosed-thinking remainder still worth calling a leak. Above this a
 * reply is very likely complete prose that merely lost its closing tag — one
 * measured sample was a 2 089-character full answer wrapped in `<thinking>`.
 */
const THINKING_LEAK_MAX = 400

/** Trailing span inspected for residue that runs to the end of the text. */
const TAIL_WINDOW = 400

/** Leading span inspected for residue that starts the text. */
const HEAD_WINDOW = 40

/** Largest text still scanned for a repetition loop (a loop is far shorter). */
const REPEAT_SCAN_MAX = 20_000

/** Shortest unterminated parameter body that counts as a broken call, not a quote. */
const UNCLOSED_BODY_MIN = 80

/** A parameter body ending a sentence has turned back into prose. */
const SENTENCE_END = /[。！？]/

/** A blank line inside a parameter body opens a new prose paragraph. */
const PARAGRAPH_BREAK = /\n[ \t]*\n/

/**
 * Longest final line still read as a bare announcement of the next tool call.
 *
 * The failure this covers looks like the model saying "读 L4320-4429 区间和 L2667
 * 附近（main）。" and then ending the turn. A real closing paragraph is longer and
 * carries its own conclusion, so length is the cheapest way to keep the rule off
 * genuine answers.
 */
const NARRATION_MAX_LINE = 60

/**
 * Shortest reply that can be called an announcement rather than an answer.
 *
 * A reply that is nothing but "先读一下配置。" is indistinguishable from a short
 * legitimate answer, and the measured failures are not shaped like that: every
 * one of them spends at least 143 characters on prose before the final line, so
 * the missing call is what the reply was building towards. Below this length the
 * judgement stays silent.
 */
const NARRATION_MIN_TEXT = 100

/**
 * Verbs that open a line whose only content is "and now I run the next tool".
 *
 * Restricted to actions the agent performs, so an answer that ends by telling
 * *the user* what to do ("改完重跑就会刷新") is not mistaken for one.
 */
const NARRATION_VERBS =
  '读|看|查|搜|扫|运行|执行|跑|测试|改|写|打开|确认|检查|对比|定位|grep|rg|awk|cat|sed|jq|read|look|check|run|search|write|edit|open|verify|inspect|dump|scan|apply|patch|load|fetch|grab'

/** Filler a model puts in front of that verb. */
const NARRATION_LEAD =
  "(?:让我|现在|接下来|然后|那么|再|先|我|好，|OK,|Now|Next|Then|Let me|I will|I'll|So)?"

/**
 * A line that opens with an action verb.
 *
 * The negative lookahead rejects the Chinese noun forms — `改动` (the change),
 * `改的`, `改完` (after changing) — because those start a *summary* line, not an
 * announcement. Without it, real closings such as "改动在 … 里，重启后生效。" were
 * flagged; measured over 381 real turn endings, this is what removed them.
 */
const NARRATION_LINE = new RegExp(
  `^[\\s>*_\\-]*${NARRATION_LEAD}[\\s,，]*(?:去|先|再)?\\s*(?:${NARRATION_VERBS})(?![动的好完成回过到在要])`,
  'i',
)

/**
 * Phrasing that hands the decision back to the user.
 *
 * "要不要我接着做第 3 项吗？" is how a healthy turn ends. It contains an action
 * verb and can be short, so it has to be excluded explicitly or the rule would
 * retry every well-formed offer to continue.
 */
const HANDS_BACK =
  /(?:要不要|需要我|要我|我可以|吗|呢|[？?]|shall I|would you like|do you want|let me know|want me to|告诉我|你说一声)/i

/** A clause separator: the line explains something instead of announcing one call. */
const CLAUSE_SEPARATOR = /[，,；;]/

/**
 * Residue a relay can leak into the text channel: DeepSeek's private
 * `｜｜DSML｜｜` tool markers (U+FF5C fullwidth bars) and reasoning tags, which no
 * part of the harness knows how to render.
 *
 * The second pattern covers the orphan form a streamed delta can leave behind,
 * where the leading `<` never arrived (`｜｜DSML｜｜ calls>`): it swallows the rest
 * of that token so nothing protocol-shaped survives.
 */
const MARKUP_PATTERNS = [
  /<\s*\/?\s*｜｜DSML｜｜[^>]*>/g,
  /｜｜DSML｜｜[^\n<>]*>?/g,
  /<\s*\/?\s*thinking\s*>/gi,
  /<\s*\/?\s*返璞归真\s*>/g,
]

/**
 * What a buffer may still hold and still count as empty: whitespace, plus the
 * punctuation an interrupted markup tag decomposes into.
 */
const ONLY_MARKUP_PUNCTUATION = /^[\s<>/\\|｜=_-]*$/

/**
 * Shapes only a leaked tool call produces. A reply that merely *discusses* the
 * residue writes `DSML` and shows a closing tag; it does not emit a parameter
 * name, an escaped parameter boundary, or an invoke header.
 */
const RESIDUE_STRONG = [
  /<parameter\s+name\s*=/i,
  /<\/\s*parameter\s*>/i,
  /:\s*parameter\s*&gt;/i,
  /<\s*\/?\s*｜｜DSML｜｜\s*(?:parameter|invoke|calls)/i,
  /\bantml:invoke\b/i,
  /<function_calls?>/i,
  /<tool▁call/i,
]

/** Anything protocol-shaped, used only to prove where the text stops being prose. */
const RESIDUE_ANY = [...RESIDUE_STRONG, /｜｜DSML｜｜/, /<tool▁calls?>/i]

/** An empty reasoning pair — what a looping model emits on repeat. */
const EMPTY_THINKING_PAIR = /<\s*thinking\s*>\s*<\s*\/\s*thinking\s*>/gi

/** An opening reasoning tag, complete enough to be the real thing. */
const OPEN_THINKING_TAG = /^\s*<thinking[^>]*>/i
const CLOSE_THINKING_TAG = /<\/thinking\s*>/i

/**
 * Remove protocol residue from one assembled text buffer.
 * @param text - concatenated text-channel content.
 * @returns the remainder, trimmed; empty when nothing survives but markup punctuation.
 */
function stripMarkup(text) {
  let rest = text
  for (const pattern of MARKUP_PATTERNS) rest = rest.replace(pattern, '')
  rest = rest.trim()
  return ONLY_MARKUP_PUNCTUATION.test(rest) ? '' : rest
}

/**
 * Offset of the last match of any pattern, scanning without touching `lastIndex`.
 * @param text - text to scan.
 * @param patterns - patterns to try, each treated as global.
 * @returns end offset (exclusive) of the rightmost match, or -1 when none matched.
 */
function lastMatchEnd(text, patterns) {
  let end = -1
  for (const pattern of patterns) {
    const global = new RegExp(pattern.source, `${pattern.flags.replace(/[gy]/g, '')}g`)
    let match
    while ((match = global.exec(text)) !== null) {
      end = Math.max(end, match.index + match[0].length)
      if (match[0].length === 0) global.lastIndex += 1
    }
  }
  return end
}

/**
 * Whether the text *ends* in protocol residue rather than merely containing it.
 *
 * This is the whole difference between the two kinds of message that carry a
 * marker. A model explaining the bug writes prose around a quoted marker, so
 * prose follows the last one. A model whose tool call collapsed stops emitting
 * prose at the moment the markup starts, so only whitespace or punctuation is
 * left after it — that is the "output stops halfway" the user sees.
 *
 * @param text - assembled text-channel content.
 * @returns true when residue runs to the end of the text.
 */
function endsInResidue(text) {
  const tail = text.slice(-TAIL_WINDOW)
  const end = lastMatchEnd(tail, RESIDUE_ANY)
  if (end < 0) return false
  return ONLY_MARKUP_PUNCTUATION.test(tail.slice(end))
}

/**
 * Offset of the leftmost match of any pattern, scanning without touching `lastIndex`.
 * @param text - text to scan.
 * @param patterns - patterns to try, each treated as global.
 * @returns start offset of the leftmost match, or -1 when none matched.
 */
function firstMatchStart(text, patterns) {
  let start = -1
  for (const pattern of patterns) {
    const global = new RegExp(pattern.source, `${pattern.flags.replace(/[gy]/g, '')}g`)
    const match = global.exec(text)
    if (match === null) continue
    if (start < 0 || match.index < start) start = match.index
  }
  return start
}

/**
 * Whether the text *begins* with leaked call structure, as when a relay drops
 * the prose and emits only the parameter block.
 *
 * Measured failures open with residue and nothing else — sometimes a stray
 * `</｜｜DSML｜｜>` before the marker, sometimes a `<thinking> </thinking>` pair.
 * What separates them from a model *explaining* the bug is that no prose comes
 * before the marker: "这一行 `<parameter name=…`" is prose, "…</｜｜DSML｜｜>\n
 * <｜｜DSML｜｜invoke" is not.
 *
 * @param text - assembled text-channel content.
 * @returns true when residue opens the text with no prose ahead of it.
 */
function startsInResidue(text) {
  const head = text.slice(0, HEAD_WINDOW)
  const start = firstMatchStart(head, RESIDUE_ANY)
  if (start < 0) return false
  return stripMarkup(head.slice(0, start)) === ''
}

/**
 * Whether the reply walks into a `<parameter>` block and never closes it.
 *
 * This is the shape that follows a line of prose: the model narrates, then
 * starts composing a call whose markup never terminates because the stream
 * ended. A quoted marker in a real answer is short and is normally closed, so
 * the body guard keeps prose out.
 *
 * The body has to still *look* like parameter content. A reply that quotes a
 * marker and then keeps explaining — a table row reading "`<parameter name=…`
 * 却永不闭合", a sentence finishing with a full stop, a blank line opening a new
 * paragraph — resumes prose inside the body, which a truncated call never does.
 *
 * @param text - assembled text-channel content.
 * @returns true when an unterminated parameter block holds a body.
 */
function hasUnclosedCall(text) {
  const openers = [...text.matchAll(/<parameter\s+name\s*=/gi)]
  if (openers.length === 0) return false
  const closers = (text.match(/<\/\s*parameter\s*>/gi) ?? []).length
  if (openers.length <= closers) return false
  const body = text.slice(openers.at(-1).index)
  if (text.length - openers.at(-1).index <= UNCLOSED_BODY_MIN) return false
  if (SENTENCE_END.test(body)) return false
  return !PARAGRAPH_BREAK.test(body)
}

/**
 * Whether the reply is nothing but an unterminated reasoning block, short enough
 * that no real answer could plausibly be hiding in it.
 * @param text - assembled text-channel content.
 * @param remainder - `stripMarkup(text)`, already computed.
 * @returns true when the reply is a leaked chain of thought.
 */
function isThinkingLeak(text, remainder) {
  if (remainder === '' || remainder.length > THINKING_LEAK_MAX) return false
  if (!OPEN_THINKING_TAG.test(text)) return false
  return !CLOSE_THINKING_TAG.test(text)
}

/**
 * Whether the reply stops immediately after announcing the call it was about to
 * make.
 *
 * This is the shape a relay leaves when it swallows the tool-call block but keeps
 * the sentence introducing it: six tool calls happen, then step seven reads
 * "读 L4320-4429 区间和 L2667 附近（main）。" with `stopReason: "stop"`, and the
 * turn is recorded as `completed`. Nothing is left over from the call itself, so
 * the residue rules above cannot see it — the only evidence is the missing
 * answer, stated as an intention.
 *
 * Only the last non-empty line is consulted, and it has to be a single short
 * clause: a line with a comma is explaining something ("改动在 X 里，重启后生效。"),
 * and one that offers to continue is a real close ("要我接着做吗？").
 *
 * @param text - assembled text-channel content.
 * @returns true when the reply ends on a bare declaration of the next action.
 */
function endsInNarration(text) {
  if (text.length < NARRATION_MIN_TEXT) return false
  const lines = text.trimEnd().split('\n').filter((line) => line.trim() !== '')
  const last = lines.at(-1) ?? ''
  if (last === '' || last.length > NARRATION_MAX_LINE) return false
  if (CLAUSE_SEPARATOR.test(last)) return false
  if (HANDS_BACK.test(last)) return false
  return NARRATION_LINE.test(last)
}

/** Accumulate the parts of one attempt that decide "did this step do anything". */
class AttemptProbe {
  /** Whether any tool call block was opened or streamed. */
  sawToolCall = false
  /** Text seen as raw deltas (delta-only protocols). */
  #deltaText = ''
  /** Text seen in closed blocks (authoritative when present). */
  #blockText = ''

  /**
   * Fold one raw stream chunk into the probe.
   * @param chunk - a chunk from the adapter stream.
   */
  observe(chunk) {
    switch (chunk?.type) {
      case 'block-start':
        if (chunk.blockType === 'tool-call') this.sawToolCall = true
        return
      case 'block-end': {
        const block = chunk.block
        if (block?.type === 'tool-call') this.sawToolCall = true
        else if (block?.type === 'text' && typeof block.text === 'string') this.#blockText += block.text
        return
      }
      case 'text-delta':
        if (typeof chunk.text === 'string') this.#deltaText += chunk.text
        return
      case 'tool-call-delta':
        this.sawToolCall = true
        return
      default:
        return
    }
  }

  /**
   * Read the text-channel content accumulated so far.
   * @returns closed-block text when the protocol sent blocks, else raw deltas.
   */
  text() {
    return this.#blockText.length > 0 ? this.#blockText : this.#deltaText
  }
}

/**
 * Build the finish chunk that replaces a broken one.
 * @param code - a code from the retry policy's default set.
 * @param message - human-readable cause, shown in the retry log.
 * @param base - the original finish chunk, when there is one.
 * @returns a finish chunk whose reason is an error.
 */
function failureFinish(code, message, base = { type: 'finish' }) {
  return { ...base, type: 'finish', reason: { kind: 'error', failure: { message, code } } }
}

/**
 * Read one config switch that may be a plain boolean or a live volatile reference.
 *
 * A `Config` field marked `.volatile()` is handed to the plugin as a frozen
 * reference (`{ get() }`, see `createVolatile` in `@deepseek-ai/cosmokit`)
 * rather than the bare value, so that the settings surface can change it
 * without remounting the plugin. Reading it per request is what makes the
 * switch take effect immediately.
 *
 * @param value - the config field as delivered by the runtime.
 * @param fallback - value to use when the field is absent or unreadable.
 * @returns the current boolean value.
 */
function readFlag(value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'boolean') return value
  if (typeof value.get === 'function') {
    try {
      return value.get() !== false
    } catch {
      return fallback
    }
  }
  return fallback
}

/** Defaults, mirroring the `Config` schema so a missing field still behaves. */
const SWITCH_DEFAULTS = {
  enabled: true,
  toolCallResidue: true,
  narrationStop: true,
  streamStall: true,
  repetition: true,
  thinkingLeak: false,
}

/**
 * Resolve every switch for one request.
 * @param config - the plugin config as delivered by the runtime.
 * @returns a plain object of booleans.
 */
function readSwitches(config) {
  const resolved = {}
  for (const [key, fallback] of Object.entries(SWITCH_DEFAULTS)) {
    resolved[key] = readFlag(config?.[key], fallback)
  }
  return resolved
}

/**
 * Resolve the idle timeout for one request.
 *
 * The value is a constant by design — a settings box for a number would invite
 * tuning a timeout nobody can predict — but the environment variable exists so
 * a test can drive the stall path without waiting ninety seconds.
 *
 * @returns the timeout in milliseconds.
 */
function idleTimeoutMs() {
  const raw = typeof process === 'undefined' ? undefined : process.env?.DSH_EMPTY_TURN_GUARD_IDLE_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_IDLE_TIMEOUT_MS
}

/**
 * Advance the upstream iterator, giving up after a deadline.
 * @param iterator - the upstream async iterator.
 * @param timeoutMs - how long to wait for the next chunk.
 * @returns `{ done, value }` for a chunk, or `{ stalled: true }` on timeout.
 */
function nextChunk(iterator, timeoutMs) {
  let timer
  // Deliberately not unref'd: while a chunk is outstanding this timer is the
  // only thing keeping the event loop alive. Unref'ing it lets the loop drain
  // while `advance` is still pending, which Node reports as "Promise
  // resolution is still pending but the event loop has already resolved".
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ stalled: true }), timeoutMs)
  })
  const advance = Promise.resolve(iterator.next())
  return Promise.race([advance, deadline]).finally(() => clearTimeout(timer))
}

/**
 * Decide whether a finished `stop` was really an answer.
 * @param probe - what the attempt produced.
 * @param switches - resolved config switches.
 * @returns a verdict `{ code, rule, detail }`, or undefined to let it through.
 */
function judgeStop(probe, switches) {
  const text = probe.text()
  const remainder = stripMarkup(text)
  if (remainder === '') {
    return { code: EMPTY_RESPONSE_CODE, rule: 'markup-only', detail: `text=${text.length}ch` }
  }
  if (
    switches.toolCallResidue &&
    (endsInResidue(text) || startsInResidue(text) || hasUnclosedCall(text))
  ) {
    return { code: TRANSPORT_CODE, rule: 'tool-call-residue', detail: `text=${text.length}ch` }
  }
  if (switches.narrationStop && endsInNarration(text)) {
    return { code: TRANSPORT_CODE, rule: 'narration-only', detail: `text=${text.length}ch` }
  }
  if (switches.thinkingLeak && isThinkingLeak(text, remainder)) {
    return { code: EMPTY_RESPONSE_CODE, rule: 'thinking-leak', detail: `text=${text.length}ch` }
  }
  return undefined
}

/**
 * Decide whether the stream is stuck in an empty-reasoning loop, mid-flight.
 *
 * Cutting the stream instead of waiting for it matters: the measured worst case
 * emitted 255 empty pairs, so waiting for the `stop` meant paying for all of
 * them before the retry could start. The pair count is only trusted while
 * nothing but residue has arrived, so a reply that thinks briefly and then
 * answers is never touched.
 *
 * @param probe - what the attempt produced so far.
 * @returns a verdict, or undefined while the stream is still plausible.
 */
function judgeFlood(probe) {
  const text = probe.text()
  if (text.length < REPEAT_LIMIT * 16 || text.length > REPEAT_SCAN_MAX) return undefined
  if (probe.sawToolCall) return undefined
  if (stripMarkup(text) !== '') return undefined
  const pairs = (text.match(EMPTY_THINKING_PAIR) ?? []).length
  if (pairs < REPEAT_LIMIT) return undefined
  return { code: EMPTY_RESPONSE_CODE, rule: 'repetition', detail: `pairs=${pairs}` }
}

/**
 * Wrap one chunk stream so a broken step becomes a retryable error.
 *
 * The upstream iterator is always closed, and closing it is never awaited: on
 * the stall path `next()` may still be pending, and awaiting `return()` would
 * hang the very code that is trying to recover.
 *
 * @param chunks - the stream returned by the rest of the `llm/stream` chain.
 * @param log - diagnostic sink; never throws.
 * @param switches - resolved config switches for this request.
 * @returns the guarded stream.
 */
async function* guard(chunks, log, switches) {
  const probe = new AttemptProbe()
  const iterator = chunks[Symbol.asyncIterator]()
  let sawFinish = false

  try {
    while (true) {
      const step = switches.streamStall
        ? await nextChunk(iterator, idleTimeoutMs())
        : await iterator.next()

      if (step.stalled) {
        log(`rewriting a stream-stalled attempt (no chunk for ${idleTimeoutMs()}ms) into ${TIMEOUT_CODE}`)
        yield failureFinish(TIMEOUT_CODE, 'the model stream went idle and never finished')
        return
      }
      if (step.done) break

      const chunk = step.value
      probe.observe(chunk)

      if (switches.repetition) {
        const flood = judgeFlood(probe)
        if (flood) {
          log(`rewriting a ${flood.rule} attempt (${flood.detail}) into ${flood.code}`)
          yield failureFinish(flood.code, 'the model repeated an empty reasoning block until the reply was worthless')
          return
        }
      }

      if (chunk?.type === 'finish') {
        sawFinish = true
        if (chunk.reason?.kind === 'stop' && !probe.sawToolCall) {
          const verdict = judgeStop(probe, switches)
          if (verdict) {
            log(`rewriting a ${verdict.rule} stop (${verdict.detail}) into ${verdict.code}`)
            yield failureFinish(verdict.code, MESSAGES[verdict.rule], chunk)
            return
          }
        }
      }

      yield chunk
    }

    if (!sawFinish && switches.streamStall) {
      log(`rewriting a stream-truncated attempt (no finish chunk) into ${TRANSPORT_CODE}`)
      yield failureFinish(TRANSPORT_CODE, 'the model stream ended without reporting how it finished')
    }
  } finally {
    try {
      const closing = iterator.return?.()
      if (closing && typeof closing.catch === 'function') closing.catch(() => {})
    } catch {
      // The upstream is already gone; nothing left to release.
    }
  }
}

/** Why each rule decided the attempt was unusable; carried into the retry log. */
const MESSAGES = {
  'markup-only': 'model returned a completed response with no usable content (protocol markup only)',
  'tool-call-residue': 'model leaked tool-call markup as text instead of calling a tool',
  'narration-only': 'model announced the next tool call and then ended the turn without making it',
  'thinking-leak': 'model returned only an unterminated reasoning block',
  repetition: 'the model repeated an empty reasoning block until the reply was worthless',
}

/**
 * Build a diagnostic sink that can never break the stream.
 * @param ctx - host plugin context.
 * @returns a one-argument log function.
 */
function makeLog(ctx) {
  const logger = ctx.logger
  const sink = typeof logger?.info === 'function' ? logger.info.bind(logger) : undefined
  return (message) => {
    try {
      sink?.(`[empty-turn-guard] ${message}`)
    } catch {
      // Diagnostics must never interfere with model output.
    }
  }
}

/**
 * Mount the guard.
 * @param ctx - host plugin context.
 * @param config - the six switches; a false `enabled` unloads the guard's
 *   listener entirely, the other five gate one judgement each.
 */
export function apply(ctx, config = {}) {
  const log = makeLog(ctx)

  if (!readSwitches(config).enabled) {
    log('disabled by config')
    return
  }

  /**
   * Wrap every agent-loop request stream.
   * @param options - the LLM request envelope.
   * @param next - the remaining waterfall chain.
   * @returns the guarded (or untouched) chunk stream.
   */
  ctx.on(
    'llm/stream',
    (options, next) => {
      const chunks = next()
      // Re-read on every request so flipping a switch needs no restart.
      const switches = readSwitches(config)
      if (!switches.enabled) return chunks
      if (!Array.isArray(options?.tools) || options.tools.length === 0) return chunks
      if (typeof chunks?.[Symbol.asyncIterator] !== 'function') return chunks
      return guard(chunks, log, switches)
    },
    { global: true, prepend: true },
  )

  ctx.logger?.info?.('empty-turn-guard: mounted (broken steps become retryable errors)')
}
