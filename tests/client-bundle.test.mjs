// Browser half: lib/client.js is a prebuilt ModuleLoader bundle, not an ES
// module, so the test evaluates it against a stub loader and a minimal React
// stand-in. It asserts the two slot registrations the settings page depends on,
// the injected form face, and that the switch stages through the text contract
// SettingsFormModel actually speaks.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const BUNDLE = new URL('../lib/client.js', import.meta.url)
const NS = 'dsh-empty-turn-guard'
const LOCALE = 'settings.emptyTurnGuard'

/**
 * Minimal React: createElement is variadic, which matters because a stand-in
 * that accepts a single child quietly drops siblings such as the switch.
 */
const createElement = (type, props, ...children) => ({
  type,
  props: {
    ...(props ?? {}),
    children: children.length <= 1 ? children[0] : children,
  },
})

const react = {
  createElement,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useId: () => 'test-id',
  useRef: () => ({ current: undefined }),
  useEffect: () => {},
}

class SettingsFormModel {
  /** Stands in for the host's writability: a read-only deployment reports false. */
  static writable = true

  constructor(scope, specs) {
    this.scope = scope
    this.specs = specs
    this.value = { enabled: true }
    this.writable = SettingsFormModel.writable
  }

  shell() {
    return { writable: this.writable }
  }

  field(field) {
    const spec = this.specs.find((candidate) => candidate.field === field)
    return { text: spec.format(this.value[field]), overridden: false }
  }

  bind(projection) {
    this.projection = projection
    return { getSnapshot: () => projection(), subscribe: () => () => {} }
  }

  actions() {
    return {
      save: async () => {},
      discard: () => {},
      resetField: () => {},
      edit: (field, text) => {
        const spec = this.specs.find((candidate) => candidate.field === field)
        const parsed = spec.parse(text)
        if (parsed?.kind === 'set') this.value[field] = parsed.value
      },
    }
  }

  dispose() {
    this.disposed = true
  }
}

const primitives = { SettingsForm: 'SettingsForm', SettingsFormModel, Switch: 'Switch' }

const stubs = {
  react,
  'react/jsx-runtime': { jsx: createElement, jsxs: createElement, Fragment: 'Fragment' },
  '@deepseek-ai/dsh-client-ui-primitives': primitives,
}

/** Evaluate the bundle and return its exports plus the id it registered under. */
function loadBundle() {
  let bundle
  globalThis.window = { __ModuleLoader__: { load: (loaded) => (bundle = loaded) } }
  new Function('window', readFileSync(BUNDLE, 'utf8'))(globalThis.window)

  assert.ok(bundle, 'the bundle calls __ModuleLoader__.load')
  const exports_ = bundle.factory((request) => {
    if (!(request in stubs)) throw new Error(`the bundle must not require ${request}`)
    return stubs[request]
  })
  return { id: bundle.id, exports: exports_ }
}

/** Mount the bundle against a stub client context and collect registrations. */
function mount() {
  const { id, exports } = loadBundle()
  const registrations = []
  const disposers = []

  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    locale: { bind: () => (key) => `t:${key}`, register: () => () => {} },
    slots: {
      inject: (_name, register) => {
        register()
        return () => {}
      },
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
    configForms: {
      get: (namespace) => ({ namespace }),
      whileServed: (_namespaces, register) => {
        register()
        return () => {}
      },
    },
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
  }

  exports.apply(ctx)
  return { id, exports, registrations, disposers }
}

const bySlot = (registrations) =>
  Object.fromEntries(registrations.map((entry) => [entry.options.name, entry]))

/** Depth-first search for every element of one type. */
function findAll(node, type, found = []) {
  if (node === null || typeof node !== 'object') return found
  if (node.type === type) found.push(node)
  const children = node.props?.children
  const flat = Array.isArray(children) ? children.flat(Infinity) : children === undefined ? [] : [children]
  for (const child of flat) findAll(child, type, found)
  return found
}

test('the bundle registers under the package name', () => {
  // client-modules keys the served bundle by this id; a mismatch silently
  // strands the half.
  assert.equal(loadBundle().id, NS)
})

test('the bundle declares the services it uses', () => {
  assert.deepEqual(loadBundle().exports.inject, ['slots', 'locale', 'configForms'])
})

test('it registers a card on both pages', () => {
  // The Plugins panel lists bundles; Settings -> Built-in plugins shows
  // per-plugin tabs. Registering into both is what makes one switch reachable
  // from wherever the user looks.
  const { registrations } = mount()
  const slots = bySlot(registrations)

  assert.equal(registrations.length, 2, 'exactly one registration per slot')
  assert.ok(slots['plugins.item'], 'a card on the Plugins panel')
  assert.ok(slots['settings.plugins.tab'], 'a tab under Settings -> Built-in plugins')
})

test('both registrations describe the same plugin', async (t) => {
  const slots = bySlot(mount().registrations)

  for (const [slot, expectedLabel] of [
    ['plugins.item', 't:title'],
    ['settings.plugins.tab', 't:tab'],
  ]) {
    await t.test(slot, () => {
      const { options } = slots[slot]
      assert.equal(options.id, 'empty-turn-guard', 'a stable, unique row id')
      assert.equal(options.order, 60, 'after the built-in sections')
      assert.equal(options.locale, LOCALE, 'translations come from one namespace')
      assert.equal(options.label(), expectedLabel, 'the label is the localized title')
    })
  }
})

test('the injected face is hooks and actions, not callbacks', async (t) => {
  const slots = bySlot(mount().registrations)

  for (const slot of ['plugins.item', 'settings.plugins.tab']) {
    await t.test(slot, () => {
      const face = slots[slot].options.inject()
      assert.ok(face.hooks.emptyTurnGuardCard, 'a snapshot store under the derived hook name')
      assert.equal(typeof face.useEmptyTurnGuardCard, 'undefined', 'the renderer derives the hook name itself')
      assert.equal(typeof face.copy, 'function', 'copy is injected as a plain prop')
      for (const action of ['save', 'discard', 'edit', 'resetField']) {
        assert.equal(typeof face[action], 'function', `${action} is wired`)
      }
    })
  }
})

test('the summary view is one line', () => {
  const slots = bySlot(mount().registrations)
  const { component, options } = slots['plugins.item']
  const rendered = component({ ...options.inject(), view: 'summary' })
  assert.equal(rendered, 't:description', 'no form, no switch')
})

test('the form view renders the shared settings frame', async (t) => {
  const slots = bySlot(mount().registrations)
  const { component, options } = slots['plugins.item']
  const rendered = component({ ...options.inject(), view: 'form' })

  await t.test('the frame', () => {
    assert.equal(rendered.type, 'SettingsForm', 'reuses the shared frame so save/discard behave the same')
    assert.equal(typeof rendered.props.onSave, 'function')
    assert.equal(typeof rendered.props.onDiscard, 'function')
    assert.deepEqual(
      Object.keys(rendered.props.labels).sort(),
      ['readOnly', 'save', 'saveFailed', 'saving', 'unavailable'],
    )
  })

  await t.test('the switch', () => {
    const [toggle] = findAll(rendered, 'Switch')
    assert.ok(toggle, 'the form renders a switch')
    assert.equal(toggle.props.checked, true, 'reflects the staged value')
    assert.equal(toggle.props.disabled, false, 'enabled while the form is writable')
  })
})

test('toggling stages the boolean through the text contract', () => {
  // SettingsFormModel only moves strings between fields and the form, so the
  // switch has to stage "true"/"false".
  const slots = bySlot(mount().registrations)
  const { component, options } = slots['plugins.item']
  const face = options.inject()
  const check = () => findAll(component({ ...face, view: 'form' }), 'Switch')[0].props.checked

  assert.equal(check(), true)
  findAll(component({ ...face, view: 'form' }), 'Switch')[0].props.onChange(false)
  assert.equal(check(), false, 'switching off stages false')
  findAll(component({ ...face, view: 'form' }), 'Switch')[0].props.onChange(true)
  assert.equal(check(), true, 'switching back on stages true')
})

test('a read-only form locks the switch', (t) => {
  t.after(() => {
    SettingsFormModel.writable = true
  })
  SettingsFormModel.writable = false

  const slots = bySlot(mount().registrations)
  const { component, options } = slots['plugins.item']
  const [toggle] = findAll(component({ ...options.inject(), view: 'form' }), 'Switch')
  assert.equal(toggle.props.disabled, true, 'the user cannot toggle what the host refuses to write')
})

test('rendering without the host hook draws nothing', () => {
  const slots = bySlot(mount().registrations)
  assert.equal(
    slots['plugins.item'].component({ view: 'form' }),
    null,
    'a missing hook must not throw on a page that never serves this namespace',
  )
})

test('unmounting disposes the form subscription', () => {
  const { disposers } = mount()
  assert.ok(disposers.length >= 1, 'the store is registered as an effect')
  for (const dispose of disposers) dispose()
})
