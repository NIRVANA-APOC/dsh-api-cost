import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { PricingEngine } from '../pricing/index.ts'
import { API_PREFIX } from '../shared/contracts.ts'
import type { ApiError, Scope } from '../shared/contracts.ts'
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

export function registerHttp(ctx: Context, queries: CostQueries, engine: PricingEngine, defaultScope: Scope): void {
  const shutdown = new AbortController()
  ctx.effect(() => () => shutdown.abort(), 'api-cost HTTP lifetime')
  const guarded = (handler: (url: URL, req: IncomingMessage, res: ServerResponse, signal: AbortSignal) => Promise<void> | void) => async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end(); return }
    // Cross-site pages cannot turn this local read surface into an expensive cold scan.
    if (req.headers['sec-fetch-site'] === 'cross-site') { sendJson(res, 403, { ok: false, code: 'CROSS_SITE', message: 'Cross-site cost queries are not allowed.' }); return }
    const controller = new AbortController()
    const onClose = (): void => { if (!res.writableEnded) controller.abort() }
    res.once('close', onClose)
    const timer = setTimeout(() => controller.abort(), 8000)
    timer.unref()
    try {
      await handler(new URL(req.url ?? '/', 'http://127.0.0.1'), req, res, AbortSignal.any([shutdown.signal, controller.signal]))
    } catch (error) {
      if (!res.destroyed && !res.writableEnded) { const result = publicError(error); sendJson(res, result.status, result.body) }
    } finally { clearTimeout(timer); res.off('close', onClose) }
  }
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
}
