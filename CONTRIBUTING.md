# Contributing

Use Node.js 22.12 or later. Install dependencies with `npm ci`, then run
`npm test` and `npm run build`. Unit tests and builds do not need an OpenAI
account. Running the instrument requires your own local Codex CLI and ChatGPT
login; use the setup and diagnosis commands in the README.

Keep the three representations consistent: bounded symbolic note events,
audible performance, and the simulated pressure field. Preserve the immediate
Stop/Refresh cancellation path, explicit Play requirement, session ownership,
and isolation of local authentication. Tests should cover behavioral changes,
especially asynchronous startup, cancellation, and native transport ordering.

The instrument's normal performance view contains only its Tidal code and
icon controls. Put setup instructions and diagnostics in the terminal or
documentation. New UI should remain usable with keyboard and assistive tools.

Include screenshots for visual changes and describe whether a capture uses
the browser synthesizer or native Tidal/SuperDirt. Never commit `.runtime/`,
OAuth files, `.env` files, local machine paths, or downloaded samples. Store
selected public screenshots under `docs/images/`; keep disposable captures
under the ignored `output/` directory.

When changing musical examples, verify their Tidal syntax with the supported
native runtime. Distinguish the source of an example from an actual Codex
composition, and distinguish illustrative wave scales from measured acoustics.
