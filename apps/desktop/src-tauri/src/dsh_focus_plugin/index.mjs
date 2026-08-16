import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const CLIENT_ENTRY_ID = 'rocketx-dsh-focus'
export const CLIENT_ROUTE_PATH = '/rocketx/dsh-focus/client.js'
const BOOT_MARKER = 'window.__DSH_BOOT__ = '
export const inject = ['webServer', 'clientModules']

function shortHash(input) {
  return createHash('sha1').update(input).digest('hex').slice(0, 12)
}

function escapeScriptJson(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c')
}

export function clientBundlePath(moduleUrl = import.meta.url) {
  return path.join(path.dirname(fileURLToPath(moduleUrl)), 'client.js')
}

export function buildClientRow(clientPath = clientBundlePath()) {
  const rev = shortHash(readFileSync(clientPath))
  return {
    id: CLIENT_ENTRY_ID,
    url: `${CLIENT_ROUTE_PATH}?rev=${rev}`,
    rev,
    immediately: true,
  }
}

export function injectFocusClientModule(html, row) {
  const markerIndex = html.indexOf(BOOT_MARKER)
  if (markerIndex < 0) {
    return html
  }
  const jsonStart = markerIndex + BOOT_MARKER.length
  const scriptEnd = html.indexOf('</script>', jsonStart)
  if (scriptEnd < 0) {
    return html
  }
  const graph = JSON.parse(html.slice(jsonStart, scriptEnd).trim())
  if (!Array.isArray(graph?.entries)) {
    return html
  }
  const entries = graph.entries.filter((entry) => entry?.id !== row.id)
  entries.push(row)
  const nextGraph = {
    ...graph,
    rev: shortHash(JSON.stringify(entries)),
    entries,
  }
  return `${html.slice(0, markerIndex)}${BOOT_MARKER}${escapeScriptJson(nextGraph)}${html.slice(scriptEnd)}`
}

export function createClientBundleHandler(clientPath = clientBundlePath()) {
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    try {
      const body = await readFile(clientPath)
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-cache',
      })
      res.end(req.method === 'HEAD' ? undefined : body)
    } catch {
      res.writeHead(404)
      res.end()
    }
  }
}

export function apply(ctx) {
  const row = buildClientRow()
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: CLIENT_ROUTE_PATH,
        handler: createClientBundleHandler(),
      }),
    'rocketx dsh focus route',
  )
  ctx.effect(
    () => ctx.webServer.tapIndex((html) => injectFocusClientModule(html, row)),
    'rocketx dsh focus boot manifest',
  )
}
