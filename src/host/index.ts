import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-commands'
/** Type-only: brings the `llm/stream` waterfall into `Events`, and nothing at runtime. */
import type {} from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import { createPricingEngine, isPricedModel } from '../pricing/index.ts'
import { PACKAGE_NAME, PROJECTION_KEY } from '../shared/contracts.ts'
import type { CostView, GateConfig, PluginConfig } from '../shared/contracts.ts'
import { createCostProjection } from './projection.ts'
import { CostQueries, QueryError, parseScope } from './query.ts'
import { registerHttp } from './http.ts'
import { createOffPeakGate, defaultGateStore } from './gate.ts'

export type * from '../shared/contracts.ts'
export const name = PACKAGE_NAME
/**
 * The two host lookups the gate's parent resolver needs, stated structurally.
 * `Context.sessions` is augmented both by the host `SessionStore` and by the
 * client session-controller registry (`ISessions`), and this package compiles
 * both halves in one program, so the merged property type is the client face.
 * The host entry points below are the documented ones; the cast is confined to
 * this resolver and the shapes are read-only.
 */
interface SessionLineage { readonly header: { readonly parentSession?: SessionId | undefined } }
interface SessionLookup { get(id: SessionId): SessionLineage | undefined }
interface AgentLineage { readonly session: SessionLineage }
interface AgentLookup { get(id: SessionId): AgentLineage | undefined }
/**
 * The projection registry and the observation reader are the whole purpose of
 * this plugin. `webServer`, `tools` and `commands` are used when the composition
 * has them, so a read-only or tool-less composition still meters correctly.
 * The checkpoint cache is deliberately NOT required here: cold recovery is the
 * query service's own optional peer, and this plugin never touches it.
 */
export const inject = ['sessionProjections', 'sessionQuery']
const holidayRange = z.union([z.string(), z.tuple([z.string(), z.string()])])
const gateSchema: z.ZodType<GateConfig> = z.object({
  enabled: z.boolean().optional(), persist: z.boolean().optional(),
  path: z.string().min(1).optional(), models: z.enum(['all', 'priced']).optional(),
}).strict()
export const configSchema: z.ZodType<PluginConfig> = z.object({
  holidays: z.record(z.string(), z.object({ holidays: z.array(holidayRange).optional(), makeupWorkdays: z.array(holidayRange).optional() }).strict()).optional(),
  defaultScope: z.enum(['auto', 'self', 'tree', 'team']).optional(),
  tool: z.boolean().optional(), command: z.boolean().optional(),
  gate: gateSchema.optional(),
}).strict()

export function describe(view: CostView): string {
  return `DeepSeek estimate · ${view.scope} · ${view.sessionCount} sessions\nTotal ¥${view.total.money.cny} / $${view.total.money.usd}`
    + `\nThis session ¥${view.own.money.cny} / $${view.own.money.usd} · others ¥${view.others.money.cny} / $${view.others.money.usd}`
    + `\n${view.total.calls} usage reports / ${view.total.attempts} settlements · ${view.total.unpricedCalls} unpriced`
    + `\nTokens: hit ${view.total.tokens.cacheHit} · miss ${view.total.tokens.cacheMiss} · output ${view.total.tokens.output}`
    + (view.coverage.status === 'complete' ? '' : `\nPARTIAL: ${view.coverage.issues.join(', ')}; unreadable ${view.coverage.failedSessions}, omitted ${view.coverage.omittedSessions}`)
}

export function apply(ctx: Context, rawConfig: PluginConfig = {}): void {
  const config = configSchema.parse(rawConfig)
  if (typeof ctx.sessionProjections?.register !== 'function' || typeof ctx.sessionQuery?.observeSession !== 'function') {
    throw new Error('dsh-api-cost 2.0 requires the DSH 0.2.0-rc.2 session projection registry and session observation capabilities.')
  }
  const engine = createPricingEngine(config.holidays)
  ctx.effect(() => ctx.sessionProjections.register(createCostProjection(engine)), 'api-cost projection')
  /**
   * The off-peak gate. One instance is shared by the middleware and the HTTP
   * surface. A switch is stored for exactly one session, but its scope is that
   * session and the sessions it delegates to: `options.sessionId` selects the
   * conversation a model call belongs to, and the live parent links decide which
   * explicit ancestor's switch governs it.
   */
  const gateConfig = config.gate ?? {}
  /**
   * The live delegation link of one session. `sessions` is authoritative; the
   * agent registry is the fallback for a session whose store entry is not visible
   * from this context. Both are read through `ctx.get`, so a composition without
   * them has no links (every session is a root) rather than failing to load, and
   * this resolver must stay synchronous and never throw: the gate calls it from
   * inside a model-call decision.
   */
  const parentOf = (sessionId: string): string | undefined => {
    try {
      const id = sessionId as SessionId
      const fromSession = (ctx.get('sessions') as unknown as SessionLookup | undefined)?.get(id)?.header.parentSession
      if (fromSession !== undefined) return String(fromSession)
      const fromAgent = (ctx.get('agents') as unknown as AgentLookup | undefined)?.get(id)?.session.header.parentSession
      return fromAgent === undefined ? undefined : String(fromAgent)
    } catch { return undefined }
  }
  const gate = createOffPeakGate({
    engine,
    config: gateConfig,
    // `config.persist === false` is honoured inside the gate; the store is only
    // the medium, so the caller always supplies the one true path.
    store: defaultGateStore(gateConfig.path),
    parentOf,
  })
  ctx.effect(() => () => gate.dispose(), 'api-cost gate lifetime')
  /**
   * `session/created` is the one announcement of a delegation link: its
   * `header.parentSession` is the durable parent lineage. The gate keeps these
   * links in memory only (the durable file stores explicit choices, never the
   * tree), so this listener is how the tree is rebuilt in a fresh process. It
   * must never throw: a synchronous `session/created` listener failure vetoes and
   * rolls back the session creation.
   */
  ctx.effect(() => ctx.on('session/created', (session) => {
    try {
      const parentSession = session.header.parentSession
      gate.observeSession(String(session.id), parentSession === undefined ? undefined : String(parentSession))
    } catch { /* a link we could not record is one the live resolver may still supply */ }
  }), 'api-cost gate parent links')
  /**
   * `llm/stream` is the one supported seam around every model call in the
   * process (the agent loop, the title generator, compaction), and the
   * waterfall resolves synchronously, so this listener must stay synchronous:
   * a `Promise` return would replace the chunk stream with a promise and break
   * every model call. `middleware` owns that contract — including returning
   * `next()` itself, unchanged, whenever this call's session is not gated.
   * `options.sessionId` is the loop-stamped session identity; a call without one
   * is never gated, and the gate never looks a session up any other way.
   */
  const models = gateConfig.models ?? 'all'
  ctx.on('llm/stream', (options, next) => models === 'priced' && !isPricedModel(options.model)
    ? next()
    : gate.middleware(options, next), { prepend: true })
  const queries = new CostQueries({
    async read(id, signal) {
      const observation = await ctx.sessionQuery.observeSession(id as SessionId, { signal, projectionMode: 'all' })
      try {
        const values = observation.projections?.values
        const ledger = values?.apiCost
        if (ledger === undefined) throw new QueryError('PROJECTION_UNAVAILABLE', 503, 'Cost projection is not available.')
        return { header: observation.header, ledger, catalog: values?.subagentCatalog, team: values?.agentTeam }
      } finally { observation[Symbol.dispose]() }
    },
    membershipRoot(id) {
      const agents = ctx.get('agents'), teams = ctx.get('agentTeams')
      const agent = agents?.get(id as SessionId)
      if (!agent || !teams) return undefined
      return teams.tryMembership(agent)?.root.id
    },
  }, config.defaultScope ?? 'auto')
  ctx.effect(() => () => queries.dispose(), 'api-cost query lifetime')
  ctx.effect(() => ctx.sessionProjections.onChanged((session, key) => {
    if (key === PROJECTION_KEY || key === 'subagentCatalog' || key === 'agentTeam') queries.invalidate(session.id)
  }), 'api-cost invalidation')
  ctx.inject(['webServer'], inner => registerHttp(inner, queries, engine, config.defaultScope ?? 'auto', gate))

  if (config.tool !== false) ctx.inject(['tools'], inner => {
    inner.tools.register({
      name: 'session_cost',
      description: 'Estimate DeepSeek cost from durable model settlements. Includes verified delegation/team spend, this-session share, and explicit unpriced or partial coverage. Not a provider bill.',
      parameters: { type: 'object', properties: { sessionId: { type: 'string' }, scope: { type: 'string', enum: ['auto', 'self', 'tree', 'team'] } }, additionalProperties: false },
      timeoutMs: 10000, isConcurrencySafe: () => true,
      output: { schema: { type: 'object', properties: { view: { type: 'object' }, text: { type: 'string' } }, required: ['view', 'text'], additionalProperties: false },
        render(_args, value) { return [{ type: 'text', text: typeof value === 'object' && value !== null && !Array.isArray(value) && typeof value.text === 'string' ? value.text : 'Cost estimate unavailable.' }] },
      },
      async execute(raw, exec) {
        const args = z.object({ sessionId: z.string().optional(), scope: z.enum(['auto', 'self', 'tree', 'team']).optional() }).strict().parse(raw)
        const id = args.sessionId ?? exec.agent?.id
        if (!id) throw new QueryError('INVALID_SESSION', 400, 'A session id is required.')
        const view = await queries.view({ sessionId: id, scope: args.scope ?? config.defaultScope ?? 'auto', signal: exec.signal })
        return { view, text: describe(view) }
      },
    })
  })
  if (config.command !== false) ctx.inject(['commands'], inner => {
    inner.commands.register({ name: 'cost', description: 'DeepSeek cost estimate, including delegation/team spend and coverage.', input: { hint: '[sessionId] [auto|self|tree|team]' },
      async handler(invocation) {
        try {
          const parts = invocation.rawInput.trim().split(/\s+/).filter(Boolean)
          if (parts.length > 2) throw new QueryError('INVALID_INPUT', 400, 'Usage: /cost [sessionId] [auto|self|tree|team]')
          const view = await queries.view({ sessionId: parts[0] ?? invocation.agent.id, scope: parseScope(parts[1], config.defaultScope ?? 'auto'), signal: invocation.signal })
          return { kind: 'success', text: describe(view) }
        } catch (error) { return { kind: 'error', text: error instanceof QueryError ? error.message : 'Cost estimate unavailable.' } }
      },
    })
  })
}
