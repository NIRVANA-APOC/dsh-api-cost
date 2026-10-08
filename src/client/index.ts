import { CSS } from './styles.ts'
import { EN, ZH, fallbackTranslate } from './locale.ts'
import type { Translate } from './locale.ts'
import { CostStore } from './store.ts'
import { createCostPill } from './widgets.tsx'
import type { ClientContext } from './types.ts'

/** The dock declaration is the only hard service; locale and timers stay optional. */
export const inject = ['slots']

const NAMESPACE = 'dsh-api-cost'

/**
 * Client half of dsh-api-cost 2.0.
 *
 * Own-session money is read straight from the Host's `apiCost` projection through
 * the framework `useProjection` seat; this half only bridges cross-session scope
 * discovery over the plugin's own GET routes. Every resource is registered
 * through `ctx.effect`, so unloading the plugin removes styles, dictionaries,
 * listeners and in-flight requests.
 */
export function apply(ctx: ClientContext): void {
  const style = typeof document === 'undefined' ? null : document.createElement('style')
  if (style) {
    style.dataset.dshPlugin = NAMESPACE
    style.textContent = CSS
    document.head.appendChild(style)
    ctx.effect(() => () => { style.remove() }, 'api-cost styles')
  }
  const locale = ctx.get('locale')
  const translate: Translate = locale ? locale.bind(NAMESPACE) : fallbackTranslate
  if (locale) {
    ctx.effect(() => locale.register(NAMESPACE, 'zh', ZH), 'api-cost zh dictionary')
    ctx.effect(() => locale.register(NAMESPACE, 'en', EN), 'api-cost en dictionary')
  }
  const store = new CostStore()
  ctx.effect(() => () => { store.dispose() }, 'api-cost client store')
  const slots = ctx.get('slots')
  if (!slots) {
    console.warn(`[${NAMESPACE}] no slots service; cost pill not mounted`)
    return
  }
  ctx.effect(() => slots.inject('conversation.composer.dock', () => slots.register(
    { name: 'conversation.composer.dock', id: 'api-cost', order: 20 },
    createCostPill(store, translate),
  )), 'api-cost dock entry')
}
