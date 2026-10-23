// Host half: the llm/stream guard.
//
// The plugin has no network or host dependency, so every case runs against a
// synthetic chunk stream and a stub context. What matters is the decision table,
// not the transport: a stop that carries nothing but protocol markup must become
// a retryable EMPTY_RESPONSE, and everything a real answer looks like must pass
// through untouched.

import test from 'node:test'
import assert from 'node:assert/strict'

import { Config, apply, name } from '../lib/index.js'

const NS = 'dsh-empty-turn-guard'

/**
 * Mount the plugin against a stub context and hand back the stream handler.
 *
 * The mount line is captured separately and `logs` is emptied afterwards, so a
 * test that inspects `logs` only ever sees what a request produced.
 */
function mount(config) {
  const handler = { fn: undefined, options: undefined }
  const logs = []
  const ctx = {
    logger: { info: (message) => logs.push(message) },
    on(event, fn, options) {
      assert.equal(event, 'llm/stream', 'the guard only listens on llm/stream')
      handler.fn = fn
      handler.options = options
      return () => {}
    },
    effect: () => () => {},
  }
  apply(ctx, config)
  const mountLog = logs.slice()
  logs.length = 0
  return { handler, logs, mountLog }
}

/** Drive the handler the way the host does: it owns `next`. */
async function collect(handler, chunks, options = { tools: [{}] }) {
  const out = []
  const upstream = async function* () {
    for (const chunk of chunks) yield chunk
  }
  for await (const chunk of handler.fn(options, () => upstream())) out.push(chunk)
  return out
}

const stop = { type: 'finish', reason: { kind: 'stop' } }
const maxTokens = { type: 'finish', reason: { kind: 'max-tokens' } }

/** A whole text block, which is how a short reply arrives. */
const textBlock = (text) => ({
  type: 'block-end',
  index: 0,
  block: { type: 'text', text },
})

/** Streamed text, which is how a long reply arrives. */
const textDelta = (text) => ({ type: 'text-delta', index: 0, text })

const toolStart = { type: 'block-start', index: 1, blockType: 'tool-call' }
const toolEnd = { type: 'block-end', index: 1, block: { type: 'tool-call' } }

/** A finish chunk rewritten into a retryable failure. */
function assertRewritten(last, label) {
  assert.equal(last?.type, 'finish', `${label}: the last chunk stays a finish`)
  assert.equal(last.reason.kind, 'error', `${label}: becomes an error`)
  assert.equal(
    last.reason.failure.code,
    'EMPTY_RESPONSE',
    `${label}: EMPTY_RESPONSE is what the retry policy already knows`,
  )
  assert.match(last.reason.failure.message, /no usable content/, `${label}: explains itself`)
}

/** Everything else must reach the caller exactly as the upstream sent it. */
function assertPassthrough(chunks, out, expectedKind, label) {
  assert.deepEqual(out, chunks, `${label}: chunks are not modified`)
  assert.equal(out.at(-1)?.reason?.kind, expectedKind, `${label}: finish kind`)
}

test('package identity', () => {
  assert.equal(name, NS, 'the row id in cordis.patch.yml must match the package name')
})

test('Config is served to the settings page', () => {
  // dsh-settings only lists a namespace when its schema has at least one
  // volatile field (see docs/root-cause.md, "Why the switch is volatile").
  const enabled = Config.dict?.enabled ?? Config.rule?.dict?.enabled
  assert.ok(enabled, 'Config exposes an `enabled` field')
  assert.equal(enabled.meta?.volatile, true, '`enabled` is volatile or the page disappears')
  assert.ok(Config['~standard'], 'Config is a Standard Schema')
  assert.equal(Config({}).enabled.get(), true, 'defaults to on')
})

test('markup-only stops become retryable failures', async (t) => {
  const { handler } = mount({})

  const cases = [
    ['DSML close tags as a whole block', [textBlock('  </｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>'), stop]],
    ['DSML close tag as a delta', [textDelta('｜｜DSML｜｜ calls>'), stop]],
    ['a tag truncated mid-markup', [textBlock('</｜｜DSML｜｜'), stop]],
    ['an empty thinking pair', [textBlock('\n<thinking> </thinking>\n'), stop]],
    ['an empty presentation tag', [textBlock('<返璞归真></返璞归真>'), stop]],
    ['whitespace only', [textBlock('   \n\t  '), stop]],
    ['markup plus punctuation', [textBlock('  </thinking> | '), stop]],
    ['deltas that only ever carried markup', [textDelta('</｜｜DSML｜｜ calls>'), textDelta('  '), stop]],
  ]

  for (const [label, chunks] of cases) {
    await t.test(label, async () => {
      const out = await collect(handler, chunks)
      assertRewritten(out.at(-1), label)
    })
  }
})

test('real replies are never touched', async (t) => {
  const { handler } = mount({})

  const cases = [
    ['a normal sentence', [textBlock('好的，我来看看这个文件。'), stop], 'stop'],
    ['a one-word answer', [textBlock('好的'), stop], 'stop'],
    ['a single symbol', [textBlock('?'), stop], 'stop'],
    ['a sentence with punctuation', [textBlock('这是一个正常的回答，包含标点。'), stop], 'stop'],
    ['streamed prose', [textDelta('先读一'), textDelta('下配置。'), stop], 'stop'],
    ['prose beside leaked markup', [textBlock('结论如下。\n<thinking> </thinking>'), stop], 'stop'],
    ['a tool call', [toolStart, toolEnd, stop], 'stop'],
    ['a tool call with preamble text', [textDelta('先跑一下。'), toolStart, toolEnd, stop], 'stop'],
  ]

  for (const [label, chunks, kind] of cases) {
    await t.test(label, async () => {
      assertPassthrough(chunks, await collect(handler, chunks), kind, label)
    })
  }
})

test('a token-limited reply is left alone', async () => {
  // max-tokens is a real answer cut short; the loop already reports it.
  const { handler, logs } = mount({})
  const chunks = [textBlock('<thinking> </thinking>'), maxTokens]
  assertPassthrough(chunks, await collect(handler, chunks), 'max-tokens', 'max-tokens')
  assert.deepEqual(logs, [], 'nothing is logged when nothing is rewritten')
})

test('background calls without tools are left alone', async () => {
  // Title generation and compaction stream the same way but declare no tools,
  // so an empty reply there is expected and must not be retried.
  const { handler } = mount({})
  const chunks = [textBlock('  </｜｜DSML｜｜ calls>'), stop]
  assertPassthrough(chunks, await collect(handler, chunks, {}), 'stop', 'no tools')
})

test('a rewrite is logged once, with the text it dropped', async () => {
  const { handler, logs } = mount({})
  const residue = '\n<thinking> </thinking>\n'
  await collect(handler, [textBlock(residue), stop])
  assert.equal(logs.length, 1, 'one line per rewrite')
  assert.match(logs[0], /rewriting an empty stop/, 'the log names the action')
  assert.match(logs[0], new RegExp(`text=${residue.length}ch`), 'the log reports the discarded length')
})

test('mounting reports itself once', () => {
  const { mountLog } = mount({})
  assert.equal(mountLog.length, 1, 'one line at mount')
  assert.match(mountLog[0], /mounted/, 'the line says the guard is live')
})

test('the handler registers globally and ahead of the adapter', () => {
  const { handler } = mount({})
  assert.deepEqual(
    handler.options,
    { global: true, prepend: true },
    'global reaches every agent; prepend lets the guard wrap the provider stream',
  )
})

test('config can switch the guard off', async (t) => {
  await t.test('at mount time', () => {
    const { handler } = mount({ enabled: false })
    assert.equal(handler.fn, undefined, 'no listener is registered')
  })

  await t.test('through a volatile config reference', async () => {
    // The host hands the plugin a volatile() reference, which reads through to
    // the live value instead of freezing the value captured at apply time.
    let on = true
    const ref = { get: () => on }
    const { handler, mountLog } = mount({ enabled: ref })
    assert.equal(mountLog.length, 1, 'mounted while enabled')

    const chunks = [textBlock('</｜｜DSML｜｜ calls>'), stop]
    assertRewritten((await collect(handler, chunks)).at(-1), 'on')

    on = false
    assertPassthrough(chunks, await collect(handler, chunks), 'stop', 'off')
    on = true
    assertRewritten((await collect(handler, chunks)).at(-1), 'on again')
  })

  await t.test('toggling a plain object between calls', async () => {
    const config = { enabled: true }
    const { handler } = mount(config)
    const chunks = [textBlock('</｜｜DSML｜｜ calls>'), stop]

    assertRewritten((await collect(handler, chunks)).at(-1), 'on')
    config.enabled = false
    assertPassthrough(chunks, await collect(handler, chunks), 'stop', 'off')
  })
})

test('chunks before the finish survive a rewrite', async () => {
  const { handler } = mount({})
  const chunks = [textDelta('</｜｜DSML｜｜ calls>'), stop]
  const out = await collect(handler, chunks)
  assert.equal(out.length, 2, 'the stream keeps its shape')
  assert.deepEqual(out[0], chunks[0], 'the delta itself is untouched')
})
