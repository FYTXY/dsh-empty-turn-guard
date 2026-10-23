# Security Policy

## Reporting A Vulnerability

Open a private report through GitHub's
[Security Advisories](../../security/advisories/new) form, or email the address
in `package.json`. Please do not open a public issue for a vulnerability.

Include the plugin version, the DSH version, the route (`openai-responses` or
`anthropic-messages`) and the relay in use, and the smallest reproduction you
have. Expect an initial reply within about a week; this is a volunteer project.

## Security Boundaries

This plugin is deliberately narrow, and knowing where its authority ends is part
of reviewing it:

- **It observes one stream and may rewrite one chunk.** The only mutation is
  replacing the `finish` chunk's reason with an `EMPTY_RESPONSE` error. It never
  edits the model's text, never drops an event, and never injects a message into
  the conversation.
- **It has no network, filesystem, or process access.** There is no `fetch`, no
  `fs`, no `child_process`, and no dependency beyond a schema library.
- **It logs through the host logger only.** Log lines contain the length of the
  discarded text (`text=24ch`), never the text itself, so model output does not
  reach log files through this plugin.
- **It is not an authorisation boundary.** The switch turns the guard off; it
  cannot grant a capability, bypass a permission preset, or change which tools
  the model may call.
- **The browser half only renders.** `lib/client.js` registers a settings card and
  stages one boolean through the host's own form model. It performs no I/O and
  reads no secret.

## Supported Versions

| Version | Supported |
| --- | --- |
| 0.4.x | Yes |
| 0.3.x | No — upgrade |
| 0.2.x and earlier | No — predates the client half and the volatile fix |

Only the latest release receives fixes.
