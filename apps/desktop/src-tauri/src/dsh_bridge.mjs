import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'

const READY_RE = /dsh web:\s+(http:\/\/127\.0\.0\.1:\d+)\b/u
const SHUTDOWN_GRACE_MS = 2_000
const SHUTDOWN_KILL_MS = 5_000
const REQUEST_TIMEOUT_MS = 110_000

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
let stdinReader = null

function emit(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}

function emitLog(stream, message) {
  emit({ kind: 'log', stream, message })
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
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

async function postJson(path, body, validate) {
  if (baseUrl === null) throw new Error('DSH web base URL is not ready')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
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
  if (!readyEmitted) {
    readyEmitted = true
    emit({ kind: 'ready', url: baseUrl })
  }
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
  const [, , dshCliArg, patchArg] = process.argv
  if (dshCliArg === undefined || patchArg === undefined) {
    throw new Error('usage: node dsh_bridge.mjs <dsh-cli> <patch>')
  }

  const dshCli = resolve(dshCliArg)
  const patch = resolve(patchArg)

  child = spawn(process.execPath, [dshCli, '--profile', 'web', '--patch', patch, '--port', '0'], {
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
      handleFatal(new Error('DSH child exited before reporting its web URL'))
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
      baseUrl = match[1]
      void connectStreams().then(resolveReady, rejectReady)
    })
    watchLines(child.stderr, 'dsh.stderr', () => {})
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
