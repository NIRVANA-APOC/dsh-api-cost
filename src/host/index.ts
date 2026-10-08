import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-commands'
import { z } from 'zod'
import { createPricingEngine } from '../pricing/index.ts'
import { PACKAGE_NAME, PROJECTION_KEY } from '../shared/contracts.ts'
import type { CostView, PluginConfig } from '../shared/contracts.ts'
import { createCostProjection } from './projection.ts'
import { CostQueries, QueryError, parseScope } from './query.ts'
import { registerHttp } from './http.ts'

export type * from '../shared/contracts.ts'
export const name = PACKAGE_NAME
/**
 * The projection registry and the observation reader are the whole purpose of
 * this plugin. `webServer`, `tools` and `commands` are used when the composition
 * has them, so a read-only or tool-less composition still meters correctly.
 * The checkpoint cache is deliberately NOT required here: cold recovery is the
 * query service's own optional peer, and this plugin never touches it.
 */
export const inject = ['sessionProjections', 'sessionQuery']
const holidayRange = z.union([z.string(), z.tuple([z.string(), z.string()])])
export const configSchema: z.ZodType<PluginConfig> = z.object({
  holidays: z.record(z.string(), z.object({ holidays: z.array(holidayRange).optional(), makeupWorkdays: z.array(holidayRange).optional() }).strict()).optional(),
  defaultScope: z.enum(['auto', 'self', 'tree', 'team']).optional(),
  tool: z.boolean().optional(), command: z.boolean().optional(),
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
  ctx.inject(['webServer'], inner => registerHttp(inner, queries, engine, config.defaultScope ?? 'auto'))

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
