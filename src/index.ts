import type { Context } from '@deepseek-ai/cordis'
import { AsyncResource } from 'node:async_hooks'
import Schema from '@deepseek-ai/schemastery'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-harness-tui/dsh-tui/extensions'
import { descendantStates, rootIdOf, subagentParent, type Retained } from './aggregate.js'
import { KEY, projection, type CostState } from './projection.js'
import { report, type ProviderMap } from './report.js'

export const name = 'dsh-opencode-cost'
export interface Config { providers: ProviderMap }
export const Config: Schema<Config> = Schema.object({
  providers: Schema.dict(Schema.union(['opencode', 'opencode-go'])).default({})
    .description('Provider id → OpenCode price table. Map aggregator aliases explicitly.'),
})
// DSH-native commands and session lifecycle; TUI contributes only a footer field.
export const inject = ['sessionProjections', 'sessions', 'agents', 'commands', 'tuiStatus']
export async function apply(ctx: Context, config: Config): Promise<void> {
  // DSH 0.2.2 awaits a registration handle that owns typed `stateOf`; 0.2.1
  // returned the disposer directly. Keep both working: await covers either
  // shape, and the registry read stays as the legacy fallback.
  const registration = await ctx.sessionProjections.register(projection) as unknown
  const handle = registration as { stateOf?: (session: Session) => CostState }
  const stateOf = (session: Session): CostState | undefined =>
    typeof handle?.stateOf === 'function'
      ? handle.stateOf(session)
      : ctx.sessionProjections.stateOf(session, KEY) as CostState | undefined
  let selected: Session | undefined
  let clear: (() => void) | undefined
  let previous = ''
  // Finished subagent sessions leave the store; keep their final projection so
  // the running total never drops when a delegation completes.
  const retained = new Map<string, Retained>()
  const lastKnown = new Map<string, CostState>()
  const parentOf = (id: string): string | undefined => {
    const live = ctx.sessions.get(id as SessionId)
    return live === undefined ? retained.get(id)?.parent : subagentParent(live)
  }
  const forgetRoot = (root: string) => {
    for (const id of [...retained.keys()]) {
      if (rootIdOf(id, parentOf) === root) { retained.delete(id); lastKnown.delete(id) }
    }
  }
  const prune = () => {
    // Prefer evicting conversations that are not on screen; only fall back to
    // the oldest live-root entry once nothing else remains.
    while (retained.size > 256) {
      let victim: string | undefined
      for (const id of retained.keys()) {
        if (!selected || rootIdOf(id, parentOf) !== String(selected.id)) { victim = id; break }
      }
      victim ??= retained.keys().next().value
      if (victim === undefined) break
      retained.delete(victim)
      lastKnown.delete(victim)
    }
  }
  const collect = (root: Session) => {
    const rootState = stateOf(root)
    if (rootState === undefined) return undefined
    const descendants = descendantStates(root, ctx.sessions.list(), retained,
      session => stateOf(session))
    for (const entry of descendants.entries) lastKnown.set(entry.id, entry.state)
    return { states: [rootState, ...descendants.entries.map(entry => entry.state)],
      subagents: descendants.agents, running: descendants.running }
  }
  // Session/command callbacks run in the emitting agent's async context.
  // Preserve our own activation context for the TUI-owned footer effect.
  const publish = AsyncResource.bind(() => {
    if (!selected) { clear?.(); clear = undefined; previous = ''; return }
    const collected = collect(selected)
    if (!collected) return
    const value = report(collected.states, config.providers ?? {},
      { subagents: collected.subagents, running: collected.running })
    const fingerprint = `${selected.id}:${value.summary}`
    if (fingerprint === previous) return
    previous = fingerprint
    clear?.()
    clear = ctx.tuiStatus.setField('opencode:cost', value.summary, {
      slot: 'right-tail', maxCells: 24, tone: 'dim',
      detail: 'Zen/Go USD estimate · session + subagents · /opencode-cost · not actual charges or quota',
    })
  })
  const belongsToSelected = (session: Session) => {
    if (!selected || subagentParent(session) === undefined) return false
    return rootIdOf(String(session.id), parentOf) === String(selected.id)
  }
  ctx.effect(() => () => { clear?.(); selected = undefined })
  ctx.commands.register({
    name: 'opencode-cost', description: 'Show OpenCode Zen/Go token-price estimates',
    handler: ({ agent }: import('@deepseek-ai/dsh-commands').CommandInvocation): import('@deepseek-ai/dsh-commands').CommandResult => {
      selected = agent.session
      publish()
      const collected = collect(agent.session)
      return collected ? { kind: 'success',
        text: report(collected.states, config.providers ?? {},
          { subagents: collected.subagents, running: collected.running }).text }
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
    // The session can outlive a transient agent release (session switches,
    // stopped background work). Keep retained subagent totals for it; only a
    // real session disposal drops the subtree.
    if (agent.session !== selected) return
    selected = undefined
    selectInitial()
  })
  ctx.on('session/created', session => {
    // A resumed id replaces any stale retained snapshot.
    retained.delete(String(session.id))
    lastKnown.delete(String(session.id))
    if (belongsToSelected(session)) publish()
  })
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'assistant/message' && event.type !== 'request/header') return
    if (session === selected) { publish(); return }
    if (belongsToSelected(session)) publish()
  })
  ctx.on('session/disposed', session => {
    const id = String(session.id)
    const parent = subagentParent(session)
    if (parent !== undefined) {
      // Capture the final projection before the child leaves the store. The
      // last published state is authoritative; the direct read is a fallback
      // for a child that never emitted a usage event.
      let state = lastKnown.get(id)
      if (state === undefined) {
        try { state = stateOf(session) } catch { state = undefined }
      }
      if (state !== undefined) retained.set(id, { parent, state })
      lastKnown.delete(id)
      prune()
      if (selected && rootIdOf(id, parentOf) === String(selected.id)) publish()
    }
    if (session !== selected) return
    forgetRoot(String(session.id))
    lastKnown.delete(String(session.id))
    selected = undefined
    selectInitial()
  })
  selectInitial()
}
