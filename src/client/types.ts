import type { ReactNode } from 'react'
import type { SessionListState, SessionSnapshot, UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import type { MaybeSnapshotSelectorHook, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { LedgerView } from '../shared/contracts.ts'
import type { LocaleKey, Translate } from './locale.ts'

// The same canonical map is augmented by the Host; no unrelated augmentation file is needed.
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap { apiCost: LedgerView }
}

/** Only native standard seats consumed by this dock entry, not an invented session state. */
export interface CostPillProps {
  readonly useProjection?: UseProjection | undefined
  readonly useSession?: MaybeSnapshotSelectorHook<SessionSnapshot> | undefined
  readonly useSessions?: SnapshotSelectorHook<SessionListState> | undefined
}
interface LocaleService {
  register(namespace: 'dsh-api-cost', language: 'zh' | 'en', dictionary: Record<LocaleKey, string>): () => void
  bind(namespace: 'dsh-api-cost'): Translate
}
interface SlotsService {
  inject(name: 'conversation.composer.dock', register: () => () => void): () => void
  register(options: { name: 'conversation.composer.dock'; id: 'api-cost'; order: number }, component: (props: CostPillProps) => ReactNode): () => void
}
/** Small public-service structural boundary; DSH imports above are type-only. */
export interface ClientContext {
  get(service: 'locale'): LocaleService | undefined
  get(service: 'slots'): SlotsService | undefined
  effect(callback: () => void | (() => void), label?: string): unknown
}
