// Host half: the llm/stream guard.
//
// The plugin has no network or host dependency, so every case runs against a
// synthetic chunk stream and a stub context. What matters is the decision table,
// not the transport: a step that cannot be a finished answer must become a
// retryable error, and everything a real answer looks like must pass through
// untouched.
//
// The pass-through cases carry most of the weight. Measured over 130 real
// residue-bearing assistant messages, 43 of them *contained* a DSML marker and
// were perfectly correct answers — models quote the residue when explaining it.
// So the table below pins down the position of the marker, not its presence.

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

/** A finish chunk rewritten into a retryable failure with the expected code. */
function assertRewritten(last, code, label) {
  assert.equal(last?.type, 'finish', `${label}: the last chunk is a finish`)
  assert.equal(last.reason.kind, 'error', `${label}: becomes an error`)
  assert.equal(last.reason.failure.code, code, `${label}: ${code} is what the retry policy knows`)
  assert.equal(typeof last.reason.failure.message, 'string', `${label}: explains itself`)
  assert.ok(last.reason.failure.message.length > 0, `${label}: the message is not empty`)
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
  const dict = Config.dict ?? Config.rule?.dict ?? {}
  const fields = ['enabled', 'toolCallResidue', 'streamStall', 'repetition', 'thinkingLeak']

  for (const field of fields) {
    const rule = dict[field]
    assert.ok(rule, `Config exposes \`${field}\``)
    assert.equal(rule.meta?.volatile, true, `\`${field}\` is volatile or the page disappears`)
  }
  assert.ok(Config['~standard'], 'Config is a Standard Schema')

  const resolved = Config({})
  assert.equal(resolved.enabled.get(), true, 'the master switch defaults to on')
  assert.equal(resolved.toolCallResidue.get(), true, 'leaked tool-call markup defaults to on')
  assert.equal(resolved.streamStall.get(), true, 'stalled streams default to on')
  assert.equal(resolved.repetition.get(), true, 'repetition defaults to on')
  assert.equal(resolved.thinkingLeak.get(), false, 'the risky judgement defaults to off')
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
      assertRewritten((await collect(handler, chunks)).at(-1), 'EMPTY_RESPONSE', label)
    })
  }
})

test('a reply whose tail is leaked tool-call markup is rewritten', async (t) => {
  const { handler } = mount({})

  const cases = [
    [
      'prose then a hanging close-tag run (the reported "stopped halfway")',
      '<thinking> </thinking>\n发现两个 Orca 配置目录：`AppData\\Roaming\\orca` 和 `AppData\\Roaming\\Orca`（大小写不同，Windows 上同一目录）。看 daemon.log。\n\n\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>',
    ],
    [
      'prose then an invoke header',
      '好，我来看看这个文件。\n<｜｜DSML｜｜invoke name="read">\n<parameter name="file_path">D:\\a.txt</parameter>',
    ],
    [
      'a reply that opens with an escaped parameter boundary',
      ':parameter&gt;\n<parameter name="command">cd \'C:\\x\'; python -c "print(1)"</parameter>',
    ],
    [
      'a reply that opens with an invoke header',
      '</｜｜DSML｜｜>\n<｜｜DSML｜｜invoke name="edit">\n<parameter name="file_path">C:\\mkword2.py</parameter>',
    ],
    [
      'prose, then a parameter block that never closes',
      'Now clean up the experimental worktrees. Let me list them first.\n\n\n<parameter name="command">$cl = "git worktree list"; Invoke-Expression $cl; foreach ($w in $cl) { Write-Host $w }',
    ],
    [
      'prose, then a parameter block with a long body',
      '看 L1299-1317 的原文。\n\nL1299 改后 `handleHttp(request, response, new URL(request.url, `http://${request.headers.host}`))` 就行了。\n\n<parameter name="command">Get-Content -Path D:\\WORKSPACE.SUN\\dsh-moyu-src\\index.js | Select-Object -Skip 1290 -First 40',
    ],
  ]

  for (const [label, text] of cases) {
    await t.test(label, async () => {
      // TRANSPORT rather than EMPTY_RESPONSE: the reply had content, it was the
      // response framing that broke.
      assertRewritten((await collect(handler, [textBlock(text), stop])).at(-1), 'TRANSPORT', label)
    })
  }
})

test('an answer that merely quotes the residue is left alone', async (t) => {
  const { handler } = mount({})

  // Measured samples: models explain this bug to the user by pasting the
  // markers into a code fence. Every one of these is a correct answer.
  const cases = [
    [
      'residue quoted inside an explanation',
      '## 直接原因：工具调用的**格式崩了**\n\n看那一轮我实际吐出来的东西：\n\n```\n</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>\n```\n\n这些是工具调用的结构标记，我本该用它们组织一个调用，结果当成正文吐了出来。跟磁盘、跟网络都没关系。',
    ],
    [
      'a long report that mentions DSML',
      `${'取证结论。'.repeat(50)}\n\n` +
        '真正发生的事是：中转服务在把 DeepSeek 原生的 DSML 工具调用标记翻译成标准协议时解析失败了，' +
        '它把残留的闭合标签 `</｜｜DSML｜｜ calls>` 当普通正文发给了宿主，并且照常发出响应完成事件。\n\n' +
        '所以这不是卡住，宿主认为模型已经正常说完话。',
    ],
    [
      'a sentence naming a parameter tag',
      '这个报错来自 `<parameter name="x">` 这一行的引号没闭合，改掉就好。',
    ],
    [
      'a quoted parameter block that is properly closed',
      '工具调用本该长这样：\n\n```\n<parameter name="command">git status --short</parameter>\n```\n\n而实际吐出来的是乱码标记。',
    ],
  ]

  for (const [label, text] of cases) {
    await t.test(label, async () => {
      const chunks = [textBlock(text), stop]
      assertPassthrough(chunks, await collect(handler, chunks), 'stop', label)
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
    ['a tool call despite residue in the text', [textBlock('</｜｜DSML｜｜ calls>'), toolStart, toolEnd, stop], 'stop'],
    ['code that mentions a marker mid-sentence', [textBlock('改这一行：`<parameter name="command">` 后面少了闭合。'), stop], 'stop'],
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

test('a stream that never reports a finish is rewritten', async () => {
  // Without a finish chunk the agent loop has no reason to report at all; the
  // step would just stop. TRANSPORT is the code that already means "the
  // response framing broke".
  const { handler, logs } = mount({})
  const out = await collect(handler, [textBlock('先读一下配置。')])
  assertRewritten(out.at(-1), 'TRANSPORT', 'no finish')
  assert.equal(logs.length, 1, 'one line per rewrite')
})

test('a stream that goes idle is rewritten as TIMEOUT', async (t) => {
  // The real timeout is 90s, so the test drives it through the environment hook
  // that exists for exactly this purpose.
  const previous = process.env.DSH_EMPTY_TURN_GUARD_IDLE_MS
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_EMPTY_TURN_GUARD_IDLE_MS
    else process.env.DSH_EMPTY_TURN_GUARD_IDLE_MS = previous
  })
  process.env.DSH_EMPTY_TURN_GUARD_IDLE_MS = '20'

  const { handler } = mount({})
  const stalled = async function* () {
    yield textDelta('开始思考')
    await new Promise(() => {})
  }
  const out = []
  for await (const chunk of handler.fn({ tools: [{}] }, () => stalled())) out.push(chunk)

  assert.equal(out.length, 2, 'the delta that did arrive is still delivered')
  assertRewritten(out.at(-1), 'TIMEOUT', 'idle')
})

test('a repetition loop is cut off before the whole loop is generated', async () => {
  // The measured worst case emitted 255 empty pairs before the turn ended; the
  // point of cutting early is that the remaining chunks are never requested.
  const { handler, logs } = mount({})
  let pulled = 0
  const pairs = Array.from({ length: 200 }, () => textDelta('<thinking> </thinking>'))
  const upstream = async function* () {
    for (const chunk of pairs) {
      pulled += 1
      yield chunk
    }
    yield stop
  }

  const out = []
  for await (const chunk of handler.fn({ tools: [{}] }, () => upstream())) out.push(chunk)

  assertRewritten(out.at(-1), 'EMPTY_RESPONSE', 'repetition')
  assert.ok(pulled < pairs.length, `stopped early (pulled ${pulled} of ${pairs.length})`)
  assert.match(logs[0], /repetition/, 'the log names the rule')
})

test('a short reply that is only unterminated thinking is opt-in', async () => {
  const leak = '<thinking>脚本已写好，现在运行它。'

  const off = mount({})
  assertPassthrough([textBlock(leak), stop], await collect(off.handler, [textBlock(leak), stop]), 'stop', 'default off')

  const on = mount({ thinkingLeak: true })
  assertRewritten(
    (await collect(on.handler, [textBlock(leak), stop])).at(-1),
    'EMPTY_RESPONSE',
    'switched on',
  )
})

test('a long reply shaped like unclosed thinking is left alone even when enabled', async () => {
  // A measured 2 089-character sample was a complete, correct answer that
  // happened to lose its closing tag. Length is what separates the two.
  const { handler } = mount({ thinkingLeak: true })
  const answer = `<thinking>好，现在可以准确回答。\n\n${'Profile 是一套命名配置的实例标识。'.repeat(60)}`
  assert.ok(answer.length > 400, 'the fixture is long enough to matter')
  assertPassthrough([textBlock(answer), stop], await collect(handler, [textBlock(answer), stop]), 'stop', 'long')
})

test('a duplicated thinking block with a real answer after it is left alone', async () => {
  // Thinking that repeats and is then followed by the reply is a style, not a
  // failure; only residue reaching the end of the text counts.
  const { handler } = mount({})
  const text = '<thinking> </thinking>\n\n<thinking> </thinking>\n\n完全通过：2 秒建工作区，accepted=True。现在清理残留并汇报。'
  assertPassthrough([textBlock(text), stop], await collect(handler, [textBlock(text), stop]), 'stop', 'repeat then answer')
})

test('background calls without tools are left alone', async () => {
  // Title generation and compaction stream the same way but declare no tools,
  // so an empty reply there is expected and must not be retried.
  const { handler } = mount({})
  const chunks = [textBlock('  </｜｜DSML｜｜ calls>'), stop]
  assertPassthrough(chunks, await collect(handler, chunks, {}), 'stop', 'no tools')
})

test('a rewrite is logged once, naming the rule and the code', async () => {
  const { handler, logs } = mount({})
  const residue = '\n<thinking> </thinking>\n'
  await collect(handler, [textBlock(residue), stop])
  assert.equal(logs.length, 1, 'one line per rewrite')
  assert.match(logs[0], /rewriting a markup-only stop/, 'the log names the rule')
  assert.match(logs[0], new RegExp(`text=${residue.length}ch`), 'the log reports the discarded length')
  assert.match(logs[0], /EMPTY_RESPONSE/, 'the log reports the code the retry policy will see')
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
    assertRewritten((await collect(handler, chunks)).at(-1), 'EMPTY_RESPONSE', 'on')

    on = false
    assertPassthrough(chunks, await collect(handler, chunks), 'stop', 'off')
    on = true
    assertRewritten((await collect(handler, chunks)).at(-1), 'EMPTY_RESPONSE', 'on again')
  })

  await t.test('toggling a plain object between calls', async () => {
    const config = { enabled: true }
    const { handler } = mount(config)
    const chunks = [textBlock('</｜｜DSML｜｜ calls>'), stop]

    assertRewritten((await collect(handler, chunks)).at(-1), 'EMPTY_RESPONSE', 'on')
    config.enabled = false
    assertPassthrough(chunks, await collect(handler, chunks), 'stop', 'off')
  })
})

test('each judgement can be switched off on its own', async (t) => {
  const residue = '先看目录。\n\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>'

  await t.test('toolCallResidue off lets a hanging tail through', async () => {
    const { handler } = mount({ toolCallResidue: false })
    const chunks = [textBlock(residue), stop]
    assertPassthrough(chunks, await collect(handler, chunks), 'stop', 'off')
  })

  await t.test('streamStall off lets a truncated stream through', async () => {
    const { handler } = mount({ streamStall: false })
    const chunks = [textBlock('先读一下配置。')]
    const out = await collect(handler, chunks)
    assert.deepEqual(out, chunks, 'the stream simply ends as it did upstream')
  })

  await t.test('repetition off lets the loop finish on its own', async () => {
    const { handler } = mount({ repetition: false })
    const pairs = Array.from({ length: 40 }, () => textDelta('<thinking> </thinking>'))
    const out = await collect(handler, [...pairs, stop])
    assert.equal(out.length, pairs.length + 1, 'every chunk still arrives')
    assertRewritten(out.at(-1), 'EMPTY_RESPONSE', 'the markup-only stop still catches it')
  })
})

test('chunks before the finish survive a rewrite', async () => {
  const { handler } = mount({})
  const chunks = [textDelta('</｜｜DSML｜｜ calls>'), stop]
  const out = await collect(handler, chunks)
  assert.equal(out.length, 2, 'the stream keeps its shape')
  assert.deepEqual(out[0], chunks[0], 'the delta itself is untouched')
})
