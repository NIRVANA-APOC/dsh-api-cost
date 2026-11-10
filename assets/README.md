# Screenshots

Declared in [`screenshots.json`](../screenshots.json) at the repository root — that
is the file storefronts (dsh-market, the awesome-dsh-plugin site) read to show the
plugin's detail view. Paths there are relative to the repository root, so keep the
two in sync if you rename anything here. The order in that file is the order the
carousel shows them in.

The two READMEs — [`README.md`](../README.md) (Chinese, the default) and
[`README.en.md`](../README.en.md) (English) — embed these same files by
repository-relative `assets/…` path, so the committed images are what a reader
sees on GitHub and in a local checkout. If a file is renamed or moved, update
`screenshots.json`, both READMEs and this table in one commit.

| File | Shows |
| --- | --- |
| `pill-off-peak.png` | The quiet composer pill in the off-peak tier: this session's cost in CNY, a hairline divider, and the tier written as the word 谷 in the off-peak blue. |
| `pill-peak.png` | The same capsule during peak hours: the tier word reads 峰 in the peak amber, so the tier never rests on colour alone. |
| `panel-session.png` | The redesigned tariff-ledger panel for one delegating session in the peak tier: the spend hero in the brand face with the USD column, the amber/blue band splitting peak and off-peak spend at a glance, the this-session / other-session split, partial coverage naming the unknown-model reason, the rates in force, and the tree-scoped Avoid-peak block — the scope copy 影响本会话及其委派的子会话, two parked requests (note that one comes from a child session), the release countdown, the elapsed wait, and one request waiting in an unrelated conversation. Token buckets and the per-model breakdown are deliberately absent; they stay in `/cost`, `session_cost` and `detail=full`. |
| `panel-team.png` | The same panel for a Team scope in the off-peak tier: the team spend hero, an all-blue band, coverage complete across seven sessions, the rates in force, and the roster with the Lead marked ★ and one money figure per member. |

All four were captured in a Chinese UI on the light theme; the labels follow the
app's language. The two panels were re-shot against the 2.3 tariff-ledger panel, so
they show the hero spend, the peak/off-peak band, the tree-scoped Avoid-peak block
(child-session scope copy included) and the Refresh button, and no
longer carry the token or per-model rows. Between 1 and 8 images are allowed, and
PNG or JPEG are both fine. Keep personal data out of
frame, and prefer names that say what the picture shows rather than when it was
taken — a dated filename rots the moment it is re-shot.
