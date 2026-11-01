import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Test-only access to the stock host admission harness/store. Production
// imports only public package types and uses injected public services.
const home = mkdtempSync(join(tmpdir(), 'opencode-cost-test-'))
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
const { KEY } = await import('../lib/projection.js')

test('stock native services, history replay, command, session isolation and unload', async () => {
  const root = new Context()
  root.logger.exporter({ colors: false, levels: { default: 4 }, export: message => console.error(message.type, ...message.args) })
  try {
    for (const service of [SessionStore, ProjectionRegistry, CommandRuntime, AgentRegistry, status.TuiStatusRuntime]) {
      await root.plugin(service).await()
    }
    for (const name of ['sessionProjections', 'sessions', 'agents', 'commands', 'tuiStatus']) assert.ok(root.get(name), name)
    const session = root.sessions.create('cost-test')
    session.append('request/header', { reason: 'initial', header: { config: { provider: 'my-provider', model: 'deepseek-v4.1-flash' } } })
    const append = (target, inputTokens = 100_000) => target.append('assistant/message', {
      turn: 1, step: 1, message: { role: 'assistant', content: [] }, stream: [],
      usage: { inputTokens, outputTokens: 10_000 },
    }, { surfaceOp: 'append' })
    append(session)
    const agent = { id: session.id, session, ctx: root, options: {}, status: 'idle' }
    const releaseAgent = root.agents.register(agent)
    await releaseAgent
    const activate = () => root.plugin(plugin, { providers: { 'my-provider': 'opencode-go' } })
    let fiber = activate()
    await fiber.await()
    // Injection starts on a subsequent microtask; bounded wait for readiness.
    for (let i = 0; i < 30 && !root.commands.find(agent, 'opencode-cost'); i++) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const command = root.commands.find(agent, 'opencode-cost')
    assert.ok(command, 'native command registered without modifying the TUI')
    const invoke = () => command.handler({ agent, rawInput: '', attachments: [], signal: new AbortController().signal, commandId: 'test' })
    const store = status.getHostStatusStore(root.get('tuiStatus'))
    const field = () => store.getFieldSnapshot().find(row => row.key === 'opencode:cost')
    assert.match(field().text, /^Go ≈\$/, 'sole root is selected before any command')
    assert.match((await invoke()).text, /1 requests/)
    const before = field().text
    const child = root.sessions.create('other-cost-test')
    child.append('request/header', { reason: 'initial', header: { config: { provider: 'opencode', model: 'gpt-6-astra' } } })
    append(child, 1_000_000)
    assert.equal(field().text, before, 'other sessions cannot steal the footer')
    // TUI/agent dispatch owns a different live activation. Footer effects
    // must retain the cost plugin's context across both event and command calls.
    let dispatched
    await root.plugin({ name: 'test-command-dispatch', apply() {
      append(session)
      dispatched = invoke()
    } }).await()
    assert.match((await dispatched).text, /2 requests/)
    assert.notEqual(field().text, before)
    const otherAgent = { id: child.id, session: child, ctx: root, options: {}, status: 'idle' }
    const releaseOther = root.agents.register(otherAgent)
    await releaseOther
    assert.match(field().text, /^Go ≈\$/)
    await releaseAgent()
    assert.match(field().text, /^Zen ≈\$/)
    append(session)
    assert.match(field().text, /^Zen ≈\$/)
    await root.agents.register(agent)
    await releaseOther()
    assert.match(field().text, /^Go ≈\$/)
    const checkpoint = root.sessionProjections.checkpoint(session)
    assert.equal(checkpoint[KEY].val.rows[0].requests, 3)
    const restored = root.sessionProjections.restore(checkpoint, [], checkpoint[KEY].seq + 1, session.header, 0)
    assert.equal(restored.checkpoint[KEY].val.rows[0].requests, 3)
    const invalid = structuredClone(checkpoint)
    invalid[KEY].val.rows[0].requests = -1
    assert.throws(() => root.sessionProjections.restore(invalid, [], checkpoint[KEY].seq + 1, session.header, 0))
    // Repeated reads and lifecycle restarts replay exactly once.
    root.sessionProjections.stateOf(session, KEY)
    assert.equal(root.sessionProjections.stateOf(session, KEY).rows[0].requests, 3)
    await fiber.dispose()
    assert.equal(field(), undefined)
    assert.equal(root.commands.find(agent, 'opencode-cost'), undefined)
    assert.equal(root.sessionProjections.stateOf(session, KEY), undefined)
    fiber = activate()
    await fiber.await()
    for (let i = 0; i < 30 && !root.commands.find(agent, 'opencode-cost'); i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(root.sessionProjections.stateOf(session, KEY).rows[0].requests, 3)
    await fiber.dispose()
  } finally {
    await root.fiber.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})
test('missing services leave plugin dormant without failing startup', async () => {
  const root = new Context()
  try {
    const fiber = root.plugin(plugin, { providers: {} })
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(fiber.error, undefined)
  }
  finally { await root.fiber.dispose() }
})
