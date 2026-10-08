import type { IssueCode } from '../shared/contracts.js';
/** The model whose published billing is disputed after the recorded epoch. */
export declare const DISPUTED_MODEL = "deepseek-v4-pro";
/**
 * Which rate-card notes are worth showing for one scope.
 *
 * The card carries caveats about itself, and one of them — the disputed
 * `deepseek-v4-pro` routing — only changes a number when the scope actually used
 * that model. Showing it on a session that never touched Pro would read as a
 * problem with that session's totals. Caveats about the calendar or the card's
 * effective date stay, because they shape the rates and the period on display.
 *
 * @param issues - the card-level issues reported by the pricing view.
 * @param models - models the scope actually priced; `undefined` when unknown.
 * @returns the issues to render, in their original order.
 */
export declare function cardNotes(issues: readonly IssueCode[], models: readonly string[] | undefined): readonly IssueCode[];
