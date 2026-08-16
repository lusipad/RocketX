import { spawn } from 'node:child_process'
import { open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join, resolve } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const READY_RE = /dsh web:\s+(http:\/\/127\.0\.0\.1:\d+)\b/u
const SHUTDOWN_GRACE_MS = 2_000
const SHUTDOWN_KILL_MS = 5_000
const REQUEST_TIMEOUT_MS = 110_000
const WEB_PROBE_TIMEOUT_MS = 10_000
const WEB_PROBE_RPC_ID = 'rocketx-dsh-web-probe'
const CHILD_STDERR_LINE_LIMIT = 80
const SESSION_FRAME_PROBE_BYTES = 8_192

const ALLOWED_METHODS = new Set([
  'session.list',
  'session.create',
  'session.history',
  'session.models',
  'session.selectModel',
  'session.prompt',
  'session.cancel',
  'agentPreset.list',
  'agentPreset.select',
  'commands/execute',
  'host.describe',
  'settings.describe',
  'settings.update',
  'settings.mutate',
  'llm.models',
  'credentials.describe',
  'credentials.set',
  'credentials.unset',
])

let child = null
let baseUrl = null
let muxSocket = null
let hostSocket = null
let shuttingDown = false
let fatalEmitted = false
let childClosed = false
let intendedExitCode = 0
let readyEmitted = false
const inflight = new Set()
const childStderrLines = []
let stdinReader = null
let sessionRepairSequence = 0

function emit(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}

function emitLog(stream, message) {
  emit({ kind: 'log', stream, message })
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function rememberChildStderr(line) {
  const message = line.trim().slice(0, 2_000)
  if (message === '') return
  childStderrLines.push(message)
  if (childStderrLines.length > CHILD_STDERR_LINE_LIMIT) childStderrLines.shift()
}

function childStartupFailure() {
  const detail = childStderrLines.find((line) => line.startsWith('Error:'))
    ?? childStderrLines.find((line) => /(?:corrupt|error|failed)/iu.test(line))
    ?? childStderrLines.at(-1)
  if (detail === undefined) return new Error('DSH child exited before reporting its web URL')
  return new Error(`DSH child exited before reporting its web URL: ${detail.replace(/^Error:\s*/u, '')}`)
}

function monolithicSessionHeaderEnd(plaintext) {
  const headerEnd = plaintext.indexOf(10) + 1
  if (headerEnd <= 0 || headerEnd === plaintext.length || plaintext.at(-1) !== 10) return null

  const lines = plaintext.toString('utf8').trimEnd().split('\n')
  let header
  try {
    header = JSON.parse(lines[0])
    for (const line of lines.slice(1)) JSON.parse(line)
  } catch {
    return null
  }
  if (!isObject(header) || header.type !== 'session' || typeof header.id !== 'string') return null
  return headerEnd
}

function reframeMonolithicSession(buffer) {
  let firstFrame
  try {
    firstFrame = zstdDecompressSync(buffer, { info: true })
  } catch {
    return null
  }
  const plaintext = firstFrame.buffer
  const headerEnd = monolithicSessionHeaderEnd(plaintext)
  if (headerEnd === null) return null

  const consumed = firstFrame.engine.bytesWritten
  if (!Number.isSafeInteger(consumed) || consumed <= 0 || consumed > buffer.length) return null
  return Buffer.concat([
    zstdCompressSync(plaintext.subarray(0, headerEnd)),
    zstdCompressSync(plaintext.subarray(headerEnd)),
    buffer.subarray(consumed),
  ])
}

async function readFirstSessionFrame(path) {
  const handle = await open(path, 'r')
  let content = Buffer.alloc(0)
  let chunkBytes = SESSION_FRAME_PROBE_BYTES
  try {
    for (;;) {
      const chunk = Buffer.allocUnsafe(chunkBytes)
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
      if (bytesRead === 0) return null
      content = Buffer.concat([content, chunk.subarray(0, bytesRead)])
      try {
        return zstdDecompressSync(content, { info: true }).buffer
      } catch {
        chunkBytes = Math.min(chunkBytes * 2, 1024 * 1024)
      }
    }
  } finally {
    await handle.close()
  }
}

async function sessionLogs(root) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const logs = []
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) logs.push(...await sessionLogs(path))
    else if (entry.isFile() && entry.name === 'session.jsonl.zstd') logs.push(path)
  }
  return logs
}

function sameSessionSnapshot(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
}

async function repairIncompatibleSessionFrames() {
  const home = process.env.DSH_HOME
  if (typeof home !== 'string' || home.trim() === '') return
  for (const path of await sessionLogs(join(home, 'sessions'))) {
    const firstFrame = await readFirstSessionFrame(path)
    if (firstFrame === null || monolithicSessionHeaderEnd(firstFrame) === null) continue
    const originalStat = await stat(path)
    const original = await readFile(path)
    if (!sameSessionSnapshot(originalStat, await stat(path))) {
      throw new Error(`DSH session changed while preparing compatibility migration: ${path}`)
    }
    const repaired = reframeMonolithicSession(original)
    if (repaired === null) continue

    const suffix = `${Date.now()}-${process.pid}-${++sessionRepairSequence}`
    const backup = `${path}.legacy-frame-${suffix}.bak`
    const temporary = `${path}.legacy-frame-${suffix}.tmp`
    await writeFile(backup, original, { flag: 'wx' })
    try {
      await writeFile(temporary, repaired, { flag: 'wx' })
      const current = await readFile(path)
      if (!sameSessionSnapshot(originalStat, await stat(path)) || !current.equals(original)) {
        throw new Error(`DSH session changed during compatibility migration: ${path}`)
      }
      await rename(temporary, path)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
    emitLog('dsh.repair', `Migrated incompatible session frame layout: ${path}`)
  }
}

function badRequest(message) {
  return {
    ok: false,
    error: {
      code: 'bad-request',
      message,
      details: { issues: [] },
    },
  }
}

function serverResponse(rpcId, result) {
  return {
    type: 'server-response',
    rpcId,
    result,
  }
}

function internalServerResponse(rpcId, error) {
  return serverResponse(rpcId, {
    ok: false,
    error: {
      code: 'internal',
      message: errorMessage(error),
      details: {},
    },
  })
}

function isObject(value) {
  return value !== null && typeof value === 'object'
}

function asRpcId(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function validateClientResponseEnvelope(value) {
  if (!isObject(value)) return 'response must be an object'
  if (value.type !== 'client-response') return 'response.type must be "client-response"'
  if (asRpcId(value.rpcId) === null) return 'response.rpcId must be a non-empty string'
  if (!isObject(value.result) || typeof value.result.ok !== 'boolean') {
    return 'response.result must be an object with boolean ok'
  }
  return null
}

function validateServerResponseEnvelope(value, expectedRpcId) {
  if (!isObject(value)) return 'server response must be an object'
  if (value.type !== 'server-response') return 'server response.type must be "server-response"'
  if (value.rpcId !== expectedRpcId) return `rpcId mismatch: expected ${expectedRpcId}, got ${String(value.rpcId)}`
  if (!isObject(value.result) || typeof value.result.ok !== 'boolean') {
    return 'server response.result must be an object with boolean ok'
  }
  return null
}

function validateReceipt(value) {
  if (!isObject(value) || typeof value.accepted !== 'boolean') {
    return 'respond receipt must be an object with boolean accepted'
  }
  if (!value.accepted && value.reason !== 'not-pending' && value.reason !== 'bad-response') {
    return 'respond receipt reason must be "not-pending" or "bad-response"'
  }
  return null
}

async function messageDataToText(data) {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
  if (typeof data?.text === 'function') return data.text()
  throw new Error(`unsupported WebSocket message type: ${Object.prototype.toString.call(data)}`)
}

function wsUrl(base, path) {
  const url = new URL(path, base)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

function closeSocket(socket) {
  if (socket === null) return
  try {
    socket.close()
  } catch {
    // Ignore close races during teardown.
  }
}

function abortInflight() {
  for (const controller of inflight) controller.abort()
  inflight.clear()
}

function scheduleBridgeExit(code) {
  if (!childClosed) return
  closeSocket(muxSocket)
  closeSocket(hostSocket)
  abortInflight()
  process.exitCode = code
  stdinReader?.close()
  process.stdin.pause()
}

function handleFatal(error, details = {}) {
  if (!fatalEmitted) {
    fatalEmitted = true
    emit({
      kind: 'fatal',
      message: errorMessage(error),
      ...details,
    })
  }
  void beginShutdown(1)
}

async function postJson(path, body, validate, timeoutMs = REQUEST_TIMEOUT_MS) {
  if (baseUrl === null) throw new Error('DSH web base URL is not ready')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  inflight.add(controller)
  try {
    const response = await fetch(new URL(path, baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`transport failure for ${path}: HTTP ${response.status}`)
    }
    const json = await response.json()
    const error = validate(json)
    if (error !== null) throw new Error(error)
    return json
  } finally {
    clearTimeout(timeout)
    inflight.delete(controller)
  }
}

function connectDownlink(kind, path) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl(baseUrl, path))
    let opened = false

    socket.addEventListener('open', () => {
      opened = true
      resolve(socket)
    }, { once: true })

    socket.addEventListener('error', () => {
      if (!opened) reject(new Error(`${kind} WebSocket failed before open`))
    }, { once: true })

    socket.addEventListener('close', (event) => {
      if (shuttingDown) return
      const error = opened
        ? new Error(`${kind} WebSocket closed unexpectedly (${event.code}${event.reason ? `: ${event.reason}` : ''})`)
        : new Error(`${kind} WebSocket closed before open (${event.code}${event.reason ? `: ${event.reason}` : ''})`)
      handleFatal(error, { stream: kind })
    })

    socket.addEventListener('message', (event) => {
      void (async () => {
        const text = await messageDataToText(event.data)
        let envelope
        try {
          envelope = JSON.parse(text)
        } catch (error) {
          throw new Error(`${kind} WebSocket received non-JSON data: ${errorMessage(error)}`)
        }
        if (!isObject(envelope)
          || envelope.type !== 'server-request'
          || asRpcId(envelope.rpcId) === null
          || typeof envelope.method !== 'string'
          || !('payload' in envelope)) {
          throw new Error(`${kind} WebSocket received an invalid server-request envelope`)
        }
        emit({ kind, envelope })
      })().catch((error) => {
        handleFatal(error, { stream: kind })
      })
    })
  })
}

async function connectStreams() {
  ;[muxSocket, hostSocket] = await Promise.all([
    connectDownlink('mux', '/api/events.mux'),
    connectDownlink('host', '/api/events.host'),
  ])
  emitReady()
}

async function verifyWebHost() {
  const response = await postJson(
    '/api/host.describe',
    {
      type: 'client-request',
      rpcId: WEB_PROBE_RPC_ID,
      method: 'host.describe',
      payload: {},
    },
    (value) => validateServerResponseEnvelope(value, WEB_PROBE_RPC_ID),
    WEB_PROBE_TIMEOUT_MS,
  )
  if (!response.result.ok) throw new Error('DSH web host.describe probe was rejected')
}

function emitReady() {
  if (readyEmitted) return
  readyEmitted = true
  emit({ kind: 'ready', url: baseUrl })
}

async function handleCall(message) {
  const rpcId = asRpcId(message.id) ?? 'invalid-request'
  const method = typeof message.method === 'string' ? message.method : null
  if (method === null) {
    emit({
      kind: 'response',
      id: rpcId,
      op: 'call',
      response: serverResponse(rpcId, badRequest('call.method must be a string')),
    })
    return
  }
  if (!ALLOWED_METHODS.has(method)) {
    emit({
      kind: 'response',
      id: rpcId,
      op: 'call',
      method,
      response: serverResponse(rpcId, badRequest(`method ${JSON.stringify(method)} is not allowed by the DSH bridge`)),
    })
    return
  }
  try {
    const response = await postJson(
      `/api/${method}`,
      {
        type: 'client-request',
        rpcId,
        method,
        payload: 'payload' in message ? message.payload : {},
      },
      (value) => validateServerResponseEnvelope(value, rpcId),
    )
    emit({ kind: 'response', id: rpcId, op: 'call', method, response })
  } catch (error) {
    if (!shuttingDown) {
      emit({
        kind: 'response',
        id: rpcId,
        op: 'call',
        method,
        response: internalServerResponse(rpcId, error),
      })
    }
  }
}

async function handleRespond(message) {
  const rpcId = asRpcId(message.id) ?? 'invalid-request'
  const envelope = message.response
  const envelopeError = validateClientResponseEnvelope(envelope)
  if (envelopeError !== null) {
    emit({
      kind: 'response',
      id: rpcId,
      op: 'respond',
      response: {
        accepted: false,
        reason: 'bad-response',
        message: envelopeError,
      },
    })
    return
  }
  try {
    const response = await postJson('/api/respond', envelope, validateReceipt)
    emit({ kind: 'response', id: rpcId, op: 'respond', response })
  } catch (error) {
    if (!shuttingDown) {
      emit({
        kind: 'response',
        id: rpcId,
        op: 'respond',
        response: {
          accepted: false,
          reason: 'bad-response',
          message: errorMessage(error),
        },
      })
    }
  }
}

function stopChild() {
  if (child === null || childClosed) return
  if (process.platform === 'win32') {
    const pid = child.pid
    if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
      const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.once('error', () => {
        if (child !== null && !childClosed) {
          try {
            child.kill()
          } catch {
            // Ignore if the child won the race.
          }
        }
      })
      killer.once('close', (code) => {
        if (code !== 0 && child !== null && !childClosed) {
          try {
            child.kill()
          } catch {
            // Ignore if the child won the race.
          }
        }
      })
      return
    }
  }
  try {
    child.kill('SIGTERM')
  } catch {
    return
  }
  setTimeout(() => {
    if (child !== null && !childClosed) {
      try {
        child.kill('SIGKILL')
      } catch {
        // Ignore if the child won the race.
      }
    }
  }, SHUTDOWN_KILL_MS)
}

async function beginShutdown(code = 0) {
  if (code !== 0) intendedExitCode = code
  if (shuttingDown) return
  shuttingDown = true
  abortInflight()
  closeSocket(muxSocket)
  closeSocket(hostSocket)
  if (child === null || childClosed) {
    scheduleBridgeExit(intendedExitCode)
    return
  }
  stopChild()
  setTimeout(() => {
    if (!childClosed) scheduleBridgeExit(intendedExitCode)
  }, SHUTDOWN_GRACE_MS)
}

function watchLines(stream, name, onLine) {
  const reader = createInterface({ input: stream })
  reader.on('line', (line) => {
    emitLog(name, line)
    onLine(line)
  })
  return reader
}

async function start() {
  const [, , dshCliArg, patchArg, modeArg] = process.argv
  if (dshCliArg === undefined || patchArg === undefined) {
    throw new Error('usage: node dsh_bridge.mjs <dsh-cli> <patch> [controller|web]')
  }

  const dshCli = resolve(dshCliArg)
  const patch = resolve(patchArg)
  if (modeArg !== undefined && modeArg !== 'controller' && modeArg !== 'web') {
    throw new Error(`unsupported DSH bridge mode: ${modeArg}`)
  }
  const mode = modeArg ?? 'controller'

  await repairIncompatibleSessionFrames()

  child = spawn(process.execPath, [dshCli, '--profile', 'web', '--patch', patch, '--host', '127.0.0.1', '--port', '0'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  child.once('error', (error) => {
    handleFatal(new Error(`failed to start DSH child: ${errorMessage(error)}`))
  })

  child.once('close', (code, signal) => {
    childClosed = true
    emit({ kind: 'exit', code, signal })
    if (!shuttingDown && baseUrl === null) {
      handleFatal(childStartupFailure())
      return
    }
    if (shuttingDown) {
      scheduleBridgeExit(intendedExitCode)
      return
    }
    scheduleBridgeExit(intendedExitCode === 0 ? (code ?? 0) : intendedExitCode)
  })

  const ready = new Promise((resolveReady, rejectReady) => {
    watchLines(child.stdout, 'dsh.stdout', (line) => {
      if (baseUrl !== null) return
      const match = READY_RE.exec(line)
      if (match === null) return
      baseUrl = new URL(match[1]).toString()
      if (mode === 'web') {
        void verifyWebHost().then(() => {
          emitReady()
          resolveReady()
        }, rejectReady)
        return
      }
      void connectStreams().then(resolveReady, rejectReady)
    })
    watchLines(child.stderr, 'dsh.stderr', rememberChildStderr)
  })

  await ready

  stdinReader = createInterface({ input: process.stdin })
  stdinReader.on('line', (line) => {
    void (async () => {
      let message
      try {
        message = JSON.parse(line)
      } catch (error) {
        throw new Error(`stdin received non-JSON data: ${errorMessage(error)}`)
      }
      if (!isObject(message) || typeof message.kind !== 'string') {
        throw new Error('stdin message must be an object with a string kind')
      }
      if (message.kind === 'shutdown') {
        await beginShutdown(0)
        return
      }
      if (message.kind === 'call') {
        await handleCall(message)
        return
      }
      if (message.kind === 'respond') {
        await handleRespond(message)
        return
      }
      throw new Error(`unsupported stdin message kind: ${message.kind}`)
    })().catch((error) => {
      handleFatal(error)
    })
  })
  stdinReader.once('close', () => {
    void beginShutdown(0)
  })
}

process.on('SIGINT', () => {
  void beginShutdown(0)
})
process.on('SIGTERM', () => {
  void beginShutdown(0)
})

void start().catch((error) => {
  handleFatal(error)
})
