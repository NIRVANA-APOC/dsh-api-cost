# Screenshots

Declared in [`screenshots.json`](../screenshots.json) at the repository root — that
is the file storefronts (dsh-market, the awesome-dsh-plugin site) read to show the
plugin's detail view. Paths there are relative to the repository root, so keep the
two in sync if you rename anything here. The order in that file is the order the
carousel shows them in.

| File | Shows |
| --- | --- |
| `pill-off-peak.png` | The composer pill in the off-peak tier: this session's cost in CNY with the tier written as a word (谷), in the neutral colour. |
| `pill-peak.png` | The same figure during peak hours: the tier reads 峰 and the capsule switches to the warning colour, so the tier never rests on colour alone. |
| `panel-session.png` | The detail panel for one delegating session: the total in CNY and USD, the this-session / other-session split, the peak / off-peak split, coverage (partial, naming the unknown-model reason), the session and priced-call counts, the period with a countdown, the rates in force, and the Refresh button. Token buckets and the per-model breakdown are deliberately absent; they stay in `/cost`, `session_cost` and `detail=full`. |
| `panel-team.png` | The same panel for a Team scope: the total with the requesting seat's own share, coverage complete across seven sessions, the roster with the Lead marked ★ and one money figure per member, and the rates in force. |

All four were captured in a Chinese UI; the labels follow the app's language. The
two panels were re-shot against the 2.0 panel, so they show the Refresh button and
no longer carry the token or per-model rows. Between 1 and 8 images are allowed, and
PNG or JPEG are both fine. Keep personal data out of frame, and prefer names that say
what the picture shows rather than when it was taken — a dated filename rots the
moment it is re-shot.
