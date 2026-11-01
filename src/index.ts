import type { Context } from '@deepseek-ai/cordis'
import { AsyncResource } from 'node:async_hooks'
import Schema from '@deepseek-ai/schemastery'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-harness-tui/dsh-tui/extensions'
import { KEY, projection } from './projection.js'
import { report, type ProviderMap } from './report.js'

export const name = 'dsh-opencode-cost'
export interface Config { providers: ProviderMap }
export const Config: Schema<Config> = Schema.object({
  providers: Schema.dict(Schema.union(['opencode', 'opencode-go'])).default({})
    .description('Provider id → OpenCode price table. Map aggregator aliases explicitly.'),
})
// DSH-native commands and session lifecycle; TUI contributes only a footer field.
export const inject = ['sessionProjections', 'sessions', 'agents', 'commands', 'tuiStatus']
export function apply(ctx: Context, config: Config): void {
  ctx.sessionProjections.register(projection)
  let selected: Session | undefined
  let clear: (() => void) | undefined
  let previous = ''
  // Session/command callbacks run in the emitting agent's async context.
  // Preserve our own activation context for the TUI-owned footer effect.
  const publish = AsyncResource.bind(() => {
    if (!selected) { clear?.(); clear = undefined; previous = ''; return }
    const state = ctx.sessionProjections.stateOf(selected, KEY)
    if (!state) return
    const value = report(state, config.providers ?? {})
    const fingerprint = `${selected.id}:${value.summary}:${value.incomplete}`
    if (fingerprint === previous) return
    previous = fingerprint
    clear?.()
    clear = ctx.tuiStatus.setField('opencode:cost', value.summary, {
      slot: 'right-tail', maxCells: 24, tone: value.incomplete ? 'warning' : 'dim',
      detail: 'Zen/Go USD estimate · current session only · /opencode-cost · not actual charges or quota',
    })
  })
  ctx.effect(() => () => { clear?.(); selected = undefined })
  ctx.commands.register({
    name: 'opencode-cost', description: 'Show OpenCode Zen/Go token-price estimates',
    handler: ({ agent }: import('@deepseek-ai/dsh-commands').CommandInvocation): import('@deepseek-ai/dsh-commands').CommandResult => {
      selected = agent.session
      publish()
      const state = ctx.sessionProjections.stateOf(agent.session, KEY)
      return state ? { kind: 'success', text: report(state, config.providers ?? {}).text }
        : { kind: 'error', text: 'OpenCode cost projection is unavailable.' }
    },
  })
  // Only an unambiguous root is eligible for initial selection. Background
  // subagent events never select a different conversation in the footer.
  const selectInitial = () => {
    if (selected) return
    const roots = ctx.agents.roots()
    if (roots.length === 1) selected = roots[0].session
    publish()
  }
  ctx.on('agent/created', () => { selectInitial(); return undefined })
  ctx.on('agent/status', selectInitial)
  ctx.on('agent/disposed', ({ agent }) => {
    if (agent.session === selected) { selected = undefined; selectInitial() }
  })
  ctx.on('session/event', (session, event) => {
    if (session !== selected) return
    if (event.type === 'assistant/message' || event.type === 'request/header') publish()
  })
  ctx.on('session/disposed', session => {
    if (session === selected) { selected = undefined; selectInitial() }
  })
  selectInitial()
}
