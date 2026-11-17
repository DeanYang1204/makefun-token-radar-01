# Token Radar — token-radar-01 entry (model radar-2)

A program (`main.ts`, Node 22, standard library only) that reads a sealed DefiLlama
snapshot and writes a dark web dashboard ranking pre-token protocols by implied
value, each with a concrete farm plan.

## What it answers

Which pre-token protocol is worth farming next, and what do I do about it? The
board covers the whole watchlist (40 protocols, ≥ $50M TVL, no token on record)
plus every other pre-token protocol the snapshot can verify as its own protocol
(158 more, 198 rows total). Live-token protocols are set aside with their market
caps shown, never mixed into the ranking.

## Run it

```sh
# from this directory, with the kit's input beside it
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

That writes `out/board.json`, `out/data.js`, `out/dashboard/`,
`out/screenshots/` and `out/dossier.json`. No network, no install, no build step.
Two runs produce byte-identical output. Run it again with a different output
directory and `diff -r` the two to check.

To view the dashboard, serve the output directory (for example
`python3 -m http.server -d out`) and open `dashboard/index.html`, or open the
file directly; it reads `data.js` beside the dashboard folder.

## The model (radar-2)

Implied value follows only from the snapshot's own figures. No protocol name is
ever special-cased, and category never changes the score — it changes what the
farmer does.

```
base    = 0.25 x min(TVL, $1B) + 0.10 x max(TVL - $1B, 0)
growth  = clamp(7d change, -60%, +150%); unknown growth counts as 0
growth multiplier = 1 + 0.70 x upside + 0.30 x downside
age multiplier    = 0.75 to 1.00 under 90 days, 1.00 to 1.05 at 90 days
                    to 3 years, then easing to 0.90
chain multiplier  = 1 + 0.04 per extra chain, up to 4 extra chains
implied = round(base x growth multiplier x age multiplier x chain multiplier)
```

Why each part:

- **Tiered TVL base.** A launch does not scale one to one with TVL for ever, so
  TVL above $1B counts less per dollar. Without the tier, the board would be a
  TVL table with a haircut.
- **Asymmetric growth.** A rising TVL is the stronger signal, so upside counts
  more than downside (0.70 vs 0.30).
- **Age curve.** It peaks at one to three years: a protocol that has barely run
  has barely earned a launch, and one that has run many years with no token is
  less likely to launch soon. Unknown age counts as 365 days.
- **Chain factor.** More chains means more surfaces to farm. Capped at four
  extra chains so a protocol listed on dozens of chains does not run away.

Worked example (rank 1 on the 2026-11-14 snapshot, Steakhouse Financial):
TVL $2.75B, 7d −2.19%, age 1.5y, 11 chains → growth ×0.9934, age ×1.0225,
chains ×1.16, implied $501.3M. The dashboard recomputes every row this way and
shows the same number `board.json` carries.

### Eligibility

A row must record no token (no market cap, no CoinGecko id, no symbol) and must
not be a wrapped, staked or bridged product of a token that already trades:
category Bridge, Canonical Bridge, Liquid Staking, Liquid Restaking, Restaked
BTC or CEX; a name carrying a whole word `wrapped`, `staked` or `staking`; a
name beginning with an exchange's name; or a name ending in a version marker.
The starter's model let wrapped and staked products (WBTC, staked ETH, bridge
tokens) top the board; this one leaves them out, which is the whole point of
the watchlist rule.

### Limits, stated plainly

- It does **not** predict whether or when a token is issued, and it has no
  launch probability, no token supply and no price. Implied value is a ranking
  claim, not a price.
- It reads one seven-day window, not a history. A protocol can be up 7 days and
  down 70.
- Age is the day tracking began, not a launch signal.
- The snapshot carries no `parentProtocol` field, so a few rows may be
  sub-products of another protocol. Nothing here claims otherwise.

## Farm plans

Every row carries 8 steps, each with a cost and a time: a fresh wallet, the
main position (the action follows the protocol's category, the capital follows
its TVL: $50 / $100 / $150 / $250), a second surface (a second chain when the
protocol runs on one, else a second action on its main chain), one qualifying
action a week, a hold of 30–60 days by age, a monthly check, claiming only from
the protocol's own published link, and a farm log. The dashboard generates the
same plan from the same rules, so the page and the board agree.

## Screenshots

Rendered in a headless browser from the built dashboard (1440×900):

- `screenshots/1-board.png` — the ranked board
- `screenshots/2-detail.png` — a protocol's detail view (model breakdown + farm plan)
- `screenshots/3-filtered.png` — the board filtered to Lending

## Layout

```
main.ts                  the program: reads the snapshot, writes /output
lib/model.ts             the model, the board, the farm plans
vendor/makefun-board.ts  the dossier library, as shipped by the kit
dashboard/index.html     the page (static, no network)
dashboard/app.css        dark theme
dashboard/app.js         search, category and chain filters, sorting,
                         detail drawer, model panel
screenshots/              the three screenshots above
LICENSE                  MIT
```

## Verification (2026-11-17, Node v24.22.1)

- 198 rows, watchlist 40/40, ranks 1–198 continuous, implied value
  non-increasing with rank, farm steps 8 per row at 124–225 characters.
- All seven gate rows pass (dashboard files, board file, sorted by value,
  coverage, farm steps, screenshots, dossier byte-match). Dossier 693,871
  bytes; dashboard source 34,999 bytes, inside the 65,536-byte text cap, so
  the judge reads the whole source.
- Two runs, `diff -r`, byte-identical.
