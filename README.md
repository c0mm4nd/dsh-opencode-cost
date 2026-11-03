# dsh-opencode-cost

An independent DSH plugin that estimates model token costs using OpenCode Zen and Go prices. Adds a status bar field and `/opencode-cost` without modifying DSH or dsh-TUI.

## Install

Requires an existing **DSH 0.2.1-rc.2 / rc.3**, **dsh-TUI 0.17.0**, and Node.js **22.19+ (22.x) or 24+** installation.

Download the `.tgz` from [Releases](https://github.com/c0mm4nd/dsh-opencode-cost/releases), then run:

```sh
dsh plugin --profile dsh-tui add /absolute/path/dsh-opencode-cost-0.1.6.tgz
```

Providers named `opencode`, `opencode-zen`, and `opencode-go` work automatically. For a custom provider or aggregator, merge this override into `~/.dsh/profiles/dsh-tui/cordis.patch.yml`:

```yaml
- id: opencode-cost
  config:
    providers:
      my-provider: opencode-go
```

Replace `my-provider` with your DSH provider ID. Use `opencode` for Zen prices or `opencode-go` for Go prices. This only selects a price table; it does not change API endpoints, credentials, or routing. The bundle already inserts the plugin row, so do not add a second `insert` block.

Restart DSH. Enable plugin fields in `/settings` and include `opencode:cost` or `*` in the plugin field list.

## Use

- The status bar shows an estimate such as `Go ≈$0.0216`. `Go` / `Zen` identifies the price table; costs are calculated per model and request. `OC` indicates mixed tables or no known provider yet. Nested subagent sessions are folded into that amount; run the command to see how many were counted.
- Run `/opencode-cost` for a provider/model breakdown with a `cache` / `non-cache` spend split, including how many subagent sessions were counted. With multiple root agents, the command selects its current session for the status bar.
- `—` means no usage yet; `unpriced` means the model has no applicable price. Responses without usable usage are ignored. Known free usage displays `$0`.
- The native `/cost` and native cost field keep their existing behavior. You can hide the native field in `/settings` if desired.

## Scope

Counting follows DSH's native cost fold: only durable `assistant/message.usage` is booked, one request per message; a message with no usable usage is dropped rather than shown as a partial estimate, for the selected root session plus every nested `origin: subagent` session under it. That keeps the same boundary as the native cost field — failed or retried attempts (`assistant/attempt`), compaction summaries, session-title generation, fork branches (each keeps its own per-session total), other root sessions, and out-of-process subagent providers are not included. Nested delegation is walked through durable `parentSession` links at any depth, and a finished subagent keeps contributing after its session leaves the in-memory store by retaining its final projection until the root session ends. Fork-inherited event prefixes stay excluded so a seeded child never double-counts its parent's usage. Context tiers apply per request, and cache tokens are priced separately. Go peak/off-peak rates use the usage event timestamp (UTC+8 weekdays, 09:00–12:00 and 14:00–18:00).

Subagent spend is reconstructed from sessions observed by the running DSH process. After a restart only the resumed root session is replayed, so subagent usage recorded in an earlier process is not recovered by this estimate.

Prices are a **2026-10-31 snapshot**, not live data. Unknown model IDs remain unpriced; prices need manual updates in `src/pricing.ts`. These are **USD list-price estimates**, not aggregator charges, Go quota consumption, or remaining allowance. The plugin makes no billing API calls and does not read API keys.

Sources: [Zen pricing](https://opencode.ai/v2/docs/console/models#pricing) and [Go usage limits](https://opencode.ai/v2/docs/console/go#usage-limits).

## Develop

```sh
git clone https://github.com/c0mm4nd/dsh-opencode-cost.git
cd dsh-opencode-cost
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm pack
```

Install pnpm 11.28.8 (pinned in `package.json`) before running these commands; the host bundles workspace packages that npm cannot reliably reinstall.

Tests cover price tiers, cache usage, provider mapping, replay, fork handling, bounded request-size buckets, nested subagent inclusion and retention, and the native command/status lifecycle. Runtime tests use the pinned host package's internal test helpers; the production plugin uses injected services and public package types.

The plugin uses Zod 4.6.7. The pinned DSH test dependencies still include older Zod versions, so a full development dependency audit may report upstream findings; installing this plugin does not upgrade DSH.

## Uninstall

```sh
dsh plugin --profile dsh-tui remove dsh-opencode-cost
```

Remove the `opencode-cost` override from your profile patch and restart DSH.

MIT licensed. GitHub distribution only; this package is not published to npm.
