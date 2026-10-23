# Contributing to dsh-empty-turn-guard

Thanks for taking the time to write a patch. This is a small plugin, so the
process is short: open an issue if you want to agree on the approach first, then
send a Pull Request.

## Before Opening A Change

- **Read [docs/root-cause.md](docs/root-cause.md) first.** It explains which
  failure this plugin targets and, just as importantly, which ones it deliberately
  does not: repetition traps that end in `max-tokens`, relay uptime, and stripping
  markup out of delivered text are out of scope.
- **Check the three conditions before loosening them.** A rewrite requires a
  `stop`, no tool call, and empty text after markup removal. Any change to that
  rule needs a test that shows a real answer still passes through untouched.
- **Keep the guard provider-neutral.** It must work the same for
  `openai-responses` and `anthropic-messages` routes, and must not import a
  provider package.

## Development Workflow

The plugin has no build step: `lib/index.js` and `lib/client.js` are the shipped
artifacts.

```sh
npm run check   # node --check on both entry points
npm test        # node --test over tests/
```

`lib/client.js` is a hand-written ModuleLoader bundle rather than an ES module,
because the browser runner loads it by evaluating
`window.__ModuleLoader__.load({ id, factory })`. Keep it dependency-free apart
from `react`, `react/jsx-runtime` and `@deepseek-ai/dsh-client-ui-primitives`, and
do not add a bundler for it.

To try a change inside a live harness:

```sh
dsh plugin --profile <name> add link:/absolute/path/to/this/repo
```

Host-side changes need a DSH restart; the browser half reloads with the page.

## Compatibility

- **Node 22 or newer** (see `engines`). CI runs Node 22 and 24 on Linux and
  Windows.
- **`@deepseek-ai/schemastery` is a peer dependency**, supplied by DSH. It is
  declared under `devDependencies` only so tests and CI have a concrete copy.
- **The schema must keep a volatile field.** `enabled` is marked `.volatile()`
  because `dsh-settings` drops any namespace whose schema has none, silently.
  Removing that call removes the settings card; see the section at the end of
  [docs/root-cause.md](docs/root-cause.md).
- **The row id must stay `dsh-empty-turn-guard`.** It is the cordis plugin name,
  the package name, the bundle patch row id, and the settings namespace at once.
  The settings card looks the namespace up by this exact string.

## Pull Requests

- One concern per PR, with a subject in the imperative mood (`fix: …`).
- Add or update a test in `tests/` for any behaviour change. Both suites must
  pass on Linux and Windows.
- Run `npm run check && npm test` before pushing.
- Update `CHANGELOG.md` under a new version heading when the change is
  user-visible, and bump `version` in `package.json` with it.
- Do not commit `node_modules/`, a `.tgz`, or a probe script.
