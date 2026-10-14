import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { PricingEngine } from '../pricing/index.ts'
import { API_PREFIX } from '../shared/contracts.ts'
import type { ApiError, Scope } from '../shared/contracts.ts'
import type { OffPeakGate } from './gate.ts'
import { CostQueries, QueryError, parseScope, validateSessionId } from './query.ts'

function sendJson(res: ServerResponse, status: number, body: unknown, etag?: string): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-cache', 'content-length': Buffer.byteLength(text), 'x-content-type-options': 'nosniff', ...(etag === undefined ? {} : { etag }) })
  res.end(text)
}
export function publicError(error: unknown): { status: number; body: ApiError } {
  if (error instanceof QueryError) return { status: error.status, body: { ok: false, code: error.code, message: error.message } }
  if (error instanceof DOMException && error.name === 'AbortError') return { status: 503, body: { ok: false, code: 'QUERY_CANCELLED', message: 'Cost query cancelled or timed out.' } }
  if (typeof error === 'object' && error !== null && 'code' in error && (error.code === 'SESSION_QUERY_NOT_FOUND' || error.code === 'SESSION_QUERY_SESSION_NOT_FOUND' || error.code === 'session/not-found')) return { status: 404, body: { ok: false, code: 'SESSION_NOT_FOUND', message: 'Session not found.' } }
  return { status: 503, body: { ok: false, code: 'SESSION_UNAVAILABLE', message: 'Cost estimate is currently unavailable.' } }
}

/** The whole body a gate mutation may carry: `{"enabled":true}`. */
const GATE_BODY_LIMIT = 4096
const INVALID_BODY_MESSAGE = 'The gate body must be a JSON object with exactly one boolean enabled key.'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function invalidBody(): QueryError { return new QueryError('INVALID_BODY', 400, INVALID_BODY_MESSAGE) }
/**
 * The gate's cross-origin rule for both methods: a browser sends `same-origin`
 * for the panel's own `fetch` and `none` for a direct navigation, and sends no
 * header at all outside a browser. Every other value — above all `cross-site` —
 * is refused, so a foreign page can never flip the switch.
 */
function crossSite(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  return site !== undefined && site !== 'same-origin' && site !== 'none'
}
/** `content-type` must be `application/json`; parameters (`; charset=utf-8`) are allowed. */
function isJsonContentType(value: string | undefined): boolean {
  return value?.split(';')[0]?.trim().toLowerCase() === 'application/json'
}
/** A present `Origin` must be exactly the scheme plus the request's own `Host`. */
function foreignOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return false
  const host = req.headers.host
  return host === undefined || (origin !== 'http://' + host && origin !== 'https://' + host)
}
/** `{"enabled": <boolean>}` and nothing else; malformed input is a 400, never a coercion. */
function parseGateBody(body: Buffer): boolean {
  let parsed: unknown
  try { parsed = JSON.parse(body.toString('utf8')) } catch { throw invalidBody() }
  if (!isRecord(parsed)) throw invalidBody()
  const keys = Object.keys(parsed)
  if (keys.length !== 1 || keys[0] !== 'enabled') throw invalidBody()
  const enabled: unknown = parsed['enabled']
  if (typeof enabled !== 'boolean') throw invalidBody()
  return enabled
}
function toBytes(chunk: unknown): Buffer | undefined {
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8')
  return chunk instanceof Uint8Array ? Buffer.from(chunk) : undefined
}
/**
 * Read at most `limit` bytes; `undefined` means the request exceeded the bound.
 * A real `IncomingMessage` is async-iterable and leaving that loop destroys it,
 * so an oversized body is torn down rather than buffered; the event API is the
 * fallback for a request double.
 */
async function readBoundedBody(req: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  const accept = (chunk: unknown): boolean => {
    const bytes = toBytes(chunk)
    if (bytes === undefined) return true
    size += bytes.byteLength
    if (size > limit) return false
    chunks.push(bytes)
    return true
  }
  if (typeof req[Symbol.asyncIterator] === 'function') {
    for await (const chunk of req) if (!accept(chunk)) return undefined
  } else if (typeof req.on === 'function') {
    const complete = await new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (value: boolean): void => { if (!settled) { settled = true; resolve(value) } }
      req.on('data', (chunk: Buffer) => { if (!accept(chunk)) finish(false) })
      req.on('end', () => finish(true))
      req.on('error', () => finish(true))
      req.on('aborted', () => finish(false))
    })
    if (!complete) return undefined
  }
  return Buffer.concat(chunks)
}

export function registerHttp(ctx: Context, queries: CostQueries, engine: PricingEngine, defaultScope: Scope, gate: OffPeakGate): void {
  const shutdown = new AbortController()
  ctx.effect(() => () => shutdown.abort(), 'api-cost HTTP lifetime')
  /** Shared request lifecycle: shutdown and client-disconnect cancellation, the 8 s read budget, and the public error taxonomy. */
  const budgeted = (handler: (req: IncomingMessage, res: ServerResponse, signal: AbortSignal) => Promise<void> | void) => async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const controller = new AbortController()
    const onClose = (): void => { if (!res.writableEnded) controller.abort() }
    res.once('close', onClose)
    const timer = setTimeout(() => controller.abort(), 8000)
    timer.unref()
    try {
      await handler(req, res, AbortSignal.any([shutdown.signal, controller.signal]))
    } catch (error) {
      if (!res.destroyed && !res.writableEnded) { const result = publicError(error); sendJson(res, result.status, result.body) }
    } finally { clearTimeout(timer); res.off('close', onClose) }
  }
  const guarded = (handler: (url: URL, req: IncomingMessage, res: ServerResponse, signal: AbortSignal) => Promise<void> | void) => budgeted(async (req, res, signal) => {
    if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end(); return }
    // Cross-site pages cannot turn this local read surface into an expensive cold scan.
    if (req.headers['sec-fetch-site'] === 'cross-site') { sendJson(res, 403, { ok: false, code: 'CROSS_SITE', message: 'Cross-site cost queries are not allowed.' }); return }
    await handler(new URL(req.url ?? '/', 'http://127.0.0.1'), req, res, signal)
  })
  /** The gate surface: one read, one mutation. Unlike `guarded` it owns both methods on one path. */
  const gateRoute = budgeted(async (req, res) => {
    if (req.method === 'GET') {
      if (crossSite(req)) throw new QueryError('CROSS_SITE', 403, 'Cross-site gate requests are not allowed.')
      const view = gate.view()
      const etag = '"' + view.revision + '"'
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag, 'cache-control': 'private, no-cache' }); res.end(); return }
      sendJson(res, 200, view, etag)
      return
    }
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'GET, POST' }); res.end(); return }
    // The mutation guard runs in this order and entirely before the body is read.
    if (crossSite(req)) throw new QueryError('CROSS_SITE', 403, 'Cross-site gate changes are not allowed.')
    if (!isJsonContentType(req.headers['content-type'])) throw new QueryError('INVALID_CONTENT_TYPE', 415, 'The gate body must be sent as application/json.')
    if (foreignOrigin(req)) throw new QueryError('CROSS_SITE', 403, 'Cross-site gate changes are not allowed.')
    const body = await readBoundedBody(req, GATE_BODY_LIMIT)
    if (body === undefined) throw invalidBody()
    sendJson(res, 200, await gate.setEnabled(parseGateBody(body)))
  })
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: API_PREFIX + '/view', handler: guarded(async (url, req, res, signal) => {
    for (const key of url.searchParams.keys()) if (!['session', 'scope', 'detail', 'force'].includes(key)) throw new QueryError('INVALID_PARAMETER', 400, 'Unsupported query parameter.')
    const detail = url.searchParams.get('detail') ?? 'summary'
    if (detail !== 'summary' && detail !== 'full') throw new QueryError('INVALID_DETAIL', 400, 'Detail must be summary or full.')
    const force = url.searchParams.get('force')
    if (force !== null && force !== '1') throw new QueryError('INVALID_FORCE', 400, 'Force must be 1 when provided.')
    const view = await queries.view({ sessionId: validateSessionId(url.searchParams.get('session') ?? ''), scope: parseScope(url.searchParams.get('scope'), defaultScope), detail, force: force === '1', signal })
    const etag = '"' + view.revision + ':' + detail + '"'
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag, 'cache-control': 'private, no-cache' }); res.end(); return }
    sendJson(res, 200, view, etag)
  }) }), 'api-cost view route')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: API_PREFIX + '/pricing', handler: guarded((_url, _req, res) => {
    sendJson(res, 200, engine.status(Date.now()))
  }) }), 'api-cost pricing route')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: API_PREFIX + '/gate', handler: gateRoute }), 'api-cost gate route')
}
