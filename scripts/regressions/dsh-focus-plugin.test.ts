import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

import {
  CLIENT_ENTRY_ID,
  CLIENT_ROUTE_PATH,
  apply as applyHostPlugin,
  buildClientRow,
  createClientBundleHandler,
  inject,
  injectFocusClientModule,
} from '../../apps/desktop/src-tauri/src/dsh_focus_plugin/index.mjs'

const clientScriptPath = path.resolve('apps/desktop/src-tauri/src/dsh_focus_plugin/client.js')

type MessageEventShape = { source: unknown; data: unknown; origin?: string }

function createSnapshotStore(initial: Record<string, unknown> = {}) {
  let snapshot = { byId: { ...initial } }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe(fn: () => void) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    set(ids: Record<string, unknown>) {
      snapshot = { byId: { ...ids } }
      for (const listener of [...listeners]) {
        listener()
      }
    },
  }
}

async function loadClientModule(timers?: {
  setTimeout?: typeof setTimeout
  clearTimeout?: typeof clearTimeout
}) {
  const script = await readFile(clientScriptPath, 'utf8')
  const listeners = new Map<string, (event: MessageEventShape) => void>()
  const posted: unknown[] = []
  const parent = {
    postMessage(message: unknown) {
      posted.push(message)
    },
  }
  const windowObject = {
    parent,
    __ModuleLoader__: {
      load(registration: { id: string; factory: () => { apply: (ctx: unknown) => void; inject: string[] } }) {
        ;(windowObject as { registration?: typeof registration }).registration = registration
      },
    },
    addEventListener(type: string, handler: (event: MessageEventShape) => void) {
      listeners.set(type, handler)
    },
    removeEventListener(type: string) {
      listeners.delete(type)
    },
  }
  vm.runInNewContext(script, {
    window: windowObject,
    globalThis: windowObject,
    Symbol,
    setTimeout: timers?.setTimeout ?? setTimeout,
    clearTimeout: timers?.clearTimeout ?? clearTimeout,
  })
  const registration = (windowObject as { registration?: { id: string; factory: () => { apply: (ctx: unknown) => void; inject: string[] } } }).registration
  assert.ok(registration, 'client bundle 必须注册模块')
  return {
    exports: registration.factory(),
    emit(event: MessageEventShape) {
      listeners.get('message')?.(event)
    },
    parent,
    posted,
  }
}

test('DSH focus host plugin 会把原生 client module 注入 boot manifest', () => {
  assert.equal(JSON.stringify(inject), JSON.stringify(['webServer', 'clientModules']))
  const row = buildClientRow()
  assert.equal(row.id, CLIENT_ENTRY_ID)
  assert.match(row.url, new RegExp(`^${CLIENT_ROUTE_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\?rev=`))
  assert.equal(row.immediately, true)

  const html =
    '<html><head><script>window.__DSH_BOOT__ = {"rev":"old","entries":[{"id":"existing","url":"/plugins/existing/client.js?rev=1","rev":"1"}]}</script></head></html>'
  const injected = injectFocusClientModule(html, row)
  assert.match(injected, /rocketx-dsh-focus/)
  assert.match(injected, /"entries":\[/)
  assert.match(injected, /"rev":"[0-9a-f]{12}"/)
})

test('DSH focus host plugin 在既有 boot manifest tap 之后追加自己的 row', () => {
  const taps: Array<(html: string) => string> = []
  const routes: Array<{ kind: string; path: string }> = []
  applyHostPlugin({
    webServer: {
      register(route: { kind: string; path: string }) {
        routes.push(route)
        return () => {}
      },
      tapIndex(transform: (html: string) => string) {
        taps.push(transform)
        return () => {}
      },
    },
    effect(setup: () => () => void) {
      setup()
    },
  })
  assert.equal(routes.length, 1)
  assert.equal(routes[0]?.kind, 'exact')
  assert.equal(routes[0]?.path, CLIENT_ROUTE_PATH)
  assert.equal(taps.length, 1)
  const upstream =
    '<html><head><script>window.__DSH_BOOT__ = {"rev":"upstream","entries":[{"id":"modules","url":"/plugins/modules/client.js?rev=1","rev":"1"}]}</script></head></html>'
  const finalHtml = taps[0](upstream)
  assert.match(finalHtml, /"id":"modules"/)
  assert.match(finalHtml, /"id":"rocketx-dsh-focus"/)
})

test('DSH focus host plugin 的 client route 提供 bundle 内容', async () => {
  const handler = createClientBundleHandler()
  const writes: Array<{ status: number; headers?: Record<string, string> }> = []
  let body: Buffer | undefined
  await handler(
    { method: 'GET' } as never,
    {
      writeHead(status: number, headers?: Record<string, string>) {
        writes.push({ status, headers })
      },
      end(value?: Buffer) {
        body = value
      },
    } as never,
  )
  assert.equal(writes[0]?.status, 200)
  assert.equal(writes[0]?.headers?.['content-type'], 'text/javascript; charset=utf-8')
  assert.ok(body?.includes(Buffer.from('rocketx:dsh-focus-session')))
})

test('DSH focus client 初始化后会立即向父窗口广播 ready', async () => {
  const { exports, emit, parent, posted } = await loadClientModule()
  exports.apply({
    sessions: {
      list: createSnapshotStore(),
      open() {},
      clear() {},
    },
    workspaces: {},
    effect(setup: () => () => void) {
      setup()
    },
  })

  assert.equal(
    JSON.stringify(posted),
    JSON.stringify([{
      type: 'rocketx:dsh-ready',
    }]),
  )

  posted.length = 0
  emit({
    source: parent,
    origin: 'tauri://localhost',
    data: { type: 'rocketx:dsh-ready-request' },
  })
  assert.equal(
    JSON.stringify(posted),
    JSON.stringify([{ type: 'rocketx:dsh-ready' }]),
  )
})

test('DSH focus client 仅接受 parent 消息，并把 RocketX 工作区打开为可输入的新会话', async () => {
  const { exports, emit, parent, posted } = await loadClientModule()
  assert.equal(JSON.stringify(exports.inject), JSON.stringify(['sessions', 'workspaces']))

  const list = createSnapshotStore({ 'session-1': {} })
  const opened: string[] = []
  const createdPaths: string[] = []
  const connectedWorkspaceIds: string[] = []
  exports.apply({
    sessions: {
      list,
      open(sessionId: string) {
        opened.push(sessionId)
      },
      clear() {},
    },
    workspaces: {
      async create({ path: workspacePath }: { path: string }) {
        createdPaths.push(workspacePath)
        return { workspaceId: 'workspace-1' }
      },
      async connectWorkspace(workspaceId: string) {
        connectedWorkspaceIds.push(workspaceId)
        return 'session-1'
      },
    },
    effect(setup: () => () => void) {
      setup()
    },
  })
  posted.length = 0

  emit({ source: {}, data: { requestId: 'ignored', type: 'rocketx:dsh-focus-session', sessionId: 'session-1' } })
  emit({
    source: parent,
    origin: 'tauri://localhost',
    data: {
      requestId: 'new-1',
      type: 'rocketx:dsh-open-new-session',
      workspacePath: 'D:/Repos/rocketchatx',
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.deepEqual(createdPaths, ['D:/Repos/rocketchatx'])
  assert.deepEqual(connectedWorkspaceIds, ['workspace-1'])
  assert.deepEqual(opened, ['session-1'])
  assert.equal(JSON.stringify(posted), JSON.stringify([{
    type: 'rocketx:dsh-ack',
    requestId: 'new-1',
    action: 'open-new-session',
    sessionId: 'session-1',
  }]))

  emit({
    source: parent,
    origin: 'tauri://localhost',
    data: { requestId: 'focus-1', type: 'rocketx:dsh-focus-session', sessionId: 'session-1' },
  })
  assert.deepEqual(opened, ['session-1', 'session-1'])
  assert.equal(
    JSON.stringify(posted.at(-1)),
    JSON.stringify({
      type: 'rocketx:dsh-ack',
      requestId: 'focus-1',
      action: 'focus-session',
      sessionId: 'session-1',
    }),
  )
})

test('DSH focus client 会等待 session 出现在 list 后再 open，并对非法 sessionId / 超时回错', async () => {
  const scheduled = new Map<number, () => void>()
  let nextTimerId = 1
  const { exports, emit, parent, posted } = await loadClientModule({
    setTimeout(callback: () => void) {
      const id = nextTimerId++
      scheduled.set(id, callback)
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeout(timer) {
      scheduled.delete(timer as unknown as number)
    },
  })
  const list = createSnapshotStore()
  const opened: string[] = []
  exports.apply({
    sessions: {
      list,
      open(sessionId: string) {
        opened.push(sessionId)
      },
      clear() {},
    },
    workspaces: {},
    effect(setup: () => () => void) {
      setup()
    },
  })
  posted.length = 0

  emit({
    source: parent,
    origin: 'tauri://localhost',
    data: { requestId: 'invalid-1', type: 'rocketx:dsh-focus-session', sessionId: '' },
  })
  assert.equal(
    JSON.stringify(posted[0]),
    JSON.stringify({
      type: 'rocketx:dsh-error',
      requestId: 'invalid-1',
      action: 'focus-session',
      error: 'invalid sessionId',
    }),
  )

  emit({
    source: parent,
    origin: 'tauri://localhost',
    data: { requestId: 'late-1', type: 'rocketx:dsh-focus-session', sessionId: 'session-late' },
  })
  assert.deepEqual(opened, [])
  assert.equal(scheduled.size, 1)
  list.set({ 'session-late': {} })
  assert.deepEqual(opened, ['session-late'])
  assert.equal(scheduled.size, 0)
  assert.equal(
    JSON.stringify(posted.at(-1)),
    JSON.stringify({
      type: 'rocketx:dsh-ack',
      requestId: 'late-1',
      action: 'focus-session',
      sessionId: 'session-late',
    }),
  )

  emit({
    source: parent,
    origin: 'tauri://localhost',
    data: { requestId: 'timeout-1', type: 'rocketx:dsh-focus-session', sessionId: 'session-timeout' },
  })
  assert.equal(scheduled.size, 1)
  const timeout = [...scheduled.values()][0]
  timeout()
  assert.deepEqual(opened, ['session-late'])
  assert.equal(
    JSON.stringify(posted.at(-1)),
    JSON.stringify({
      type: 'rocketx:dsh-error',
      requestId: 'timeout-1',
      action: 'focus-session',
      sessionId: 'session-timeout',
      error: 'session did not appear in time',
    }),
  )
})

test('后到的聚焦请求会让尚未完成的新建请求失效，避免覆盖当前房间会话', async () => {
  const { exports, emit, parent, posted } = await loadClientModule()
  const list = createSnapshotStore({ 'session-existing': {} })
  const opened: string[] = []
  let resolveWorkspace: ((workspace: { workspaceId: string }) => void) | undefined
  const workspaceCreated = new Promise<{ workspaceId: string }>((resolve) => {
    resolveWorkspace = resolve
  })
  let connectCount = 0
  exports.apply({
    sessions: {
      list,
      open(sessionId: string) {
        opened.push(sessionId)
      },
      clear() {},
    },
    workspaces: {
      create() {
        return workspaceCreated
      },
      async connectWorkspace() {
        connectCount += 1
        return 'session-new'
      },
    },
    effect(setup: () => () => void) {
      setup()
    },
  })
  posted.length = 0

  emit({
    source: parent,
    origin: 'tauri://localhost',
    data: {
      requestId: 'new-slow',
      type: 'rocketx:dsh-open-new-session',
      workspacePath: 'D:/Repos/rocketchatx',
    },
  })
  emit({
    source: parent,
    origin: 'tauri://localhost',
    data: {
      requestId: 'focus-current',
      type: 'rocketx:dsh-focus-session',
      sessionId: 'session-existing',
    },
  })

  assert.deepEqual(opened, ['session-existing'])
  resolveWorkspace?.({ workspaceId: 'workspace-new' })
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(connectCount, 0)
  assert.deepEqual(opened, ['session-existing'])
  assert.equal(
    JSON.stringify(posted),
    JSON.stringify([{
      type: 'rocketx:dsh-ack',
      requestId: 'focus-current',
      action: 'focus-session',
      sessionId: 'session-existing',
    }]),
  )
})
