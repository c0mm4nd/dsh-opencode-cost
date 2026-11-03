import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Same stock-host harness as runtime.test.mjs: the production plugin only sees
// public services, but subagent sessions must be real store entries.
const home = mkdtempSync(join(tmpdir(), 'opencode-cost-subagent-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_TUI_ADAPTER_MODE = 'new'
const hostRoot = fileURLToPath(import.meta.resolve('@deepseek-harness-tui/dsh-tui/plugin-host')).replace(/lib\/types\/plugin-host\.js$/, '')
const hostModule = path => import(pathToFileURL(join(hostRoot, 'lib/types', path)).href)
const { Context } = await import('@deepseek-ai/cordis')
const { default: SessionStore } = await import('@deepseek-ai/dsh-session')
const { default: ProjectionRegistry } = await import('@deepseek-ai/dsh-session-projection')
const { default: CommandRuntime } = await import('@deepseek-ai/dsh-commands')
const { default: AgentRegistry } = await import('@deepseek-ai/dsh-agent')
const status = await hostModule('dsh-adapter/status.js')
const plugin = await import('../lib/index.js')

const provider = 'opencode-go'
const model = 'deepseek-v4.1-flash'
const appendHeader = (session, p = provider, m = model) => session.append('request/header', {
  reason: 'initial', header: { config: { provider: p, model: m } },
})
// The footer must only carry the accumulated amount; subagent counts belong
// to the command breakdown.
const amountOf = text => {
  const match = /≈\$([0-9.eE+-]+)/.exec(text)
  return match === null ? undefined : Number(match[1])
}
const appendUsage = (session, inputTokens = 100_000, outputTokens = 10_000) => session.append('assistant/message', {
  turn: 1, step: 1, message: { role: 'assistant', content: [] }, stream: [],
  usage: { inputTokens, outputTokens },
}, { surfaceOp: 'append' })

async function bootstrap() {
  const root = new Context()
  try {
    for (const service of [SessionStore, ProjectionRegistry, CommandRuntime, AgentRegistry, status.TuiStatusRuntime]) {
      await root.plugin(service).await()
    }
  } catch (error) {
    await root.fiber.dispose()
    throw error
  }
  return root
}

async function activate(root, mapping = {}) {
  const fiber = root.plugin(plugin, { providers: mapping })
  await fiber.await()
  return fiber
}

async function waitForCommand(root, agent) {
  for (let i = 0; i < 50 && !root.commands.find(agent, 'opencode-cost'); i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return root.commands.find(agent, 'opencode-cost')
}

test('live nested subagent sessions are folded into the selected root', async () => {
  const root = await bootstrap()
  try {
    const parent = root.sessions.create('cost-root')
    appendHeader(parent)
    appendUsage(parent)
    const agent = { id: parent.id, session: parent, ctx: root, options: {}, status: 'idle' }
    await root.agents.register(agent)
    await activate(root)
    const command = await waitForCommand(root, agent)
    assert.ok(command)
    const invoke = () => command.handler({ agent, rawInput: '', attachments: [], signal: new AbortController().signal, commandId: 'test' })
    const store = status.getHostStatusStore(root.get('tuiStatus'))
    const field = () => store.getFieldSnapshot().find(row => row.key === 'opencode:cost')

    assert.doesNotMatch(field().text, /sub/)
    const initial = amountOf(field().text)
    assert.ok(initial > 0)
    assert.match((await invoke()).text, /; 1 requests/)

    const child = root.sessions.create('cost-child', {
      meta: { origin: 'subagent', parentSession: parent.id, delegationDepth: 1 },
    })
    appendHeader(child)
    appendUsage(child)
    assert.doesNotMatch(field().text, /sub/)
    assert.ok(amountOf(field().text) > initial)
    assert.match((await invoke()).text, /; 2 requests/)
    assert.match((await invoke()).text, /Includes 1 subagent session \(1 running, 0 finished\)\./)

    const grandchild = root.sessions.create('cost-grandchild', {
      meta: { origin: 'subagent', parentSession: child.id, delegationDepth: 2 },
    })
    appendHeader(grandchild)
    appendUsage(grandchild)
    const withGrandchild = amountOf(field().text)
    assert.ok(withGrandchild > initial)
    assert.match((await invoke()).text, /; 3 requests/)
    assert.match((await invoke()).text, /Includes 2 subagent sessions \(2 running, 0 finished\)\./)

    // A fork child with durable lineage but no subagent classification is not
    // delegation spend and must not inflate the total.
    const fork = root.sessions.create('cost-fork', {
      meta: { parentSession: parent.id, delegationDepth: 1 },
    })
    appendHeader(fork)
    appendUsage(fork)
    assert.equal(amountOf(field().text), withGrandchild, 'fork lineage is not delegation spend')
    assert.match((await invoke()).text, /; 3 requests/)
  } finally {
    await root.fiber.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('a finished subagent keeps contributing after its session leaves the store', async () => {
  const root = await bootstrap()
  try {
    const parent = root.sessions.create('cost-root-2')
    appendHeader(parent)
    appendUsage(parent)
    const agent = { id: parent.id, session: parent, ctx: root, options: {}, status: 'idle' }
    await root.agents.register(agent)
    await activate(root)
    const command = await waitForCommand(root, agent)
    assert.ok(command)
    const invoke = () => command.handler({ agent, rawInput: '', attachments: [], signal: new AbortController().signal, commandId: 'test' })
    const store = status.getHostStatusStore(root.get('tuiStatus'))
    const field = () => store.getFieldSnapshot().find(row => row.key === 'opencode:cost')

    // `sessions.create` owns the detach through the caller's fiber; prepare +
    // enter + announce exposes it so the test can finish one subagent.
    const prepared = root.sessions.prepare('cost-finished', {
      meta: { origin: 'subagent', parentSession: parent.id, delegationDepth: 1 },
    })
    const detach = root.sessions.enter(prepared)
    root.sessions.announce(prepared)
    appendHeader(prepared)
    appendUsage(prepared, 1_000_000, 0)
    assert.doesNotMatch(field().text, /sub/)
    const totalWithChild = field().text
    assert.match((await invoke()).text, /Includes 1 subagent session \(1 running, 0 finished\)\./)

    detach()
    assert.equal(root.sessions.get(prepared.id), undefined)
    assert.equal(field().text, totalWithChild, 'finishing a subagent must not change the running total')
    assert.doesNotMatch(field().text, /sub/)
    const text = (await invoke()).text
    assert.match(text, /Includes 1 subagent session \(0 running, 1 finished\)\./)
    assert.match(text, /; 2 requests/)
  } finally {
    await root.fiber.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})
