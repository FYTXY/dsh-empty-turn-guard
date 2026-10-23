/**
 * dsh-empty-turn-guard — turn a "silently finished" step into a retryable error.
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
 * through), measures what the attempt actually produced, and — when a `stop`
 * carries no tool call and nothing beyond protocol markup and whitespace —
 * rewrites the finish reason into an `EMPTY_RESPONSE` error. That code sits in
 * the provider's default retryable set, so `@deepseek-ai/dsh-llm-retry` retries
 * the step with backoff instead of ending the turn on nothing.
 *
 * Only agent-loop turns are inspected: the request envelope carries the active
 * tool declarations, while background calls (session titles, summaries) send
 * none, and a retry there would only add noise.
 *
 * Non-goals: this does not repair the relay, does not strip markup from the
 * delivered text, and does not touch degenerate repetition that ends as
 * `max-tokens` (that already surfaces as its own visible outcome).
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
 * `enabled` is the one switch the settings surface writes; the namespace itself
 * is the row id, so the client half spells `dsh-empty-turn-guard` and finds this
 * schema.
 */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile().description('残渣空回合自动重试 / retry markup-only replies'),
})

/**
 * Provider-neutral code the retry policy already treats as safely repeatable.
 * @see DEFAULT_RETRYABLE_CODES in @deepseek-ai/dsh-llm
 */
const EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE'

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
 * Wrap one chunk stream so a markup-only stop becomes a retryable error.
 * @param chunks - the stream returned by the rest of the `llm/stream` chain.
 * @param log - diagnostic sink; never throws.
 * @returns the guarded stream.
 */
async function* guard(chunks, log) {
  const probe = new AttemptProbe()
  for await (const chunk of chunks) {
    probe.observe(chunk)
    const reason = chunk?.type === 'finish' ? chunk.reason : undefined
    if (reason?.kind === 'stop' && !probe.sawToolCall) {
      const text = probe.text()
      if (stripMarkup(text) === '') {
        log(`rewriting an empty stop (text=${text.length}ch) into ${EMPTY_RESPONSE_CODE}`)
        yield {
          ...chunk,
          reason: {
            kind: 'error',
            failure: {
              message: 'model returned a completed response with no usable content (protocol markup only)',
              code: EMPTY_RESPONSE_CODE,
            },
          },
        }
        continue
      }
    }
    yield chunk
  }
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
 * Read a config flag that may be a plain boolean or a live volatile reference.
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

/**
 * Mount the guard.
 * @param ctx - host plugin context.
 * @param config - `{ enabled }`; the settings switch writes `enabled: false` to
 *   turn the guard off without unloading the plugin.
 */
export function apply(ctx, config = {}) {
  const log = makeLog(ctx)

  if (!readFlag(config?.enabled, true)) {
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
      // Re-read on every request so flipping the switch needs no restart.
      if (!readFlag(config?.enabled, true)) return chunks
      if (!Array.isArray(options?.tools) || options.tools.length === 0) return chunks
      if (typeof chunks?.[Symbol.asyncIterator] !== 'function') return chunks
      return guard(chunks, log)
    },
    { global: true, prepend: true },
  )

  ctx.logger?.info?.('empty-turn-guard: mounted (markup-only stops become EMPTY_RESPONSE retries)')
}
