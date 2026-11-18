[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/DeanYang1204/makefun-token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/DeanYang1204/makefun-token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

An entry for [make.fun's "Build the best token launch radar" bounty](https://make.fun/bounty/token-radar-01) — $1,325 in USDC.

# Token Radar

One Node 22 program (`main.ts`, standard library only) that turns a sealed
DefiLlama snapshot into a dark dashboard. The dashboard ranks protocols that
have no token yet by the value a token would imply, and gives each one a
farming plan a reader can actually follow.

## The question it answers

Which protocol without a token is worth farming next, and what should I do
about it? The board starts from the snapshot's watchlist — 40 protocols with
at least $50M locked and no token on record — and adds every other protocol
the snapshot can confirm is its own thing and has no token, 158 more, for
198 rows in all. Protocols that already have a token are kept out of the
ranking and shown separately with their market caps, so the two never mix.

## Running it

```sh
# from this directory, with the kit's input beside it
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

That produces `out/board.json`, `out/data.js`, `out/dashboard/`,
`out/screenshots/` and `out/dossier.json`. Nothing is fetched, installed or
built. Run it twice into two directories and `diff -r` them: the outputs are
identical byte for byte.

To look at the page, serve the output directory (for instance
`python3 -m http.server -d out`) and open `dashboard/index.html`. The page
reads `data.js` from beside its own folder.

## How the ranking works (model radar-2)

The implied value comes only from numbers in the snapshot. No protocol is
ever favoured by name, and a protocol's category never moves its score — it
only changes what the farmer is told to do.

```
base              = 0.25 x min(TVL, $1B) + 0.10 x max(TVL - $1B, 0)
growth            = clamp(7d change, -60%, +150%); no figure counts as 0
growth multiplier = 1 + 0.70 x upside + 0.30 x downside
age multiplier    = 0.75 rising to 1.00 over the first 90 days, then to
                    1.05 by 3 years, then easing back toward 0.90
chain multiplier  = 1 + 0.04 for each chain past the first, at most 4
implied           = round(base x growth multiplier x age multiplier
                          x chain multiplier)
```

Why it is shaped this way:

- **The TVL tier.** A launch does not track TVL dollar for dollar for ever,
  so value locked above $1B earns the lower multiple. Without the tier the
  ranking would be a TVL list with a discount applied.
- **Lopsided growth.** A rising TVL is the better sign, so a rise is weighted
  more than a fall (0.70 against 0.30).
- **The age curve.** It tops out between one and three years. A protocol
  that has barely started has barely earned a launch, and one that has run
  for many years without a token is less likely to launch soon. A missing
  listing date is treated as 365 days.
- **The chain lift.** Running on more chains means more places to farm, so
  each extra chain adds a little. The lift stops at four extra chains, so a
  protocol listed on dozens of chains cannot run away with the board.

One row, worked through (the top row on the 2026-11-14 snapshot, Steakhouse
Financial): TVL $2.75B, 7d −2.19%, listed 1.5 years, 11 chains. That gives
growth ×0.9934, age ×1.0225 and chains ×1.16, for an implied $501.3M. The
dashboard recomputes each row the same way and shows the number `board.json`
carries.

### Who gets on the board

A row has to show no token at all — no market cap, no CoinGecko id, no
symbol — and it must not be a wrapped, staked or bridged form of a token
that already trades. That rules out the categories Bridge, Canonical Bridge,
Liquid Staking, Liquid Restaking, Restaked BTC and CEX; a name with a whole
word `wrapped`, `staked` or `staking`; a name that starts with an exchange's
name; and a name that ends in a version marker. The kit's starter let
wrapped and staked products (WBTC, staked ETH, bridge tokens) sit at the top
of its board; leaving them out is the point of the watchlist rule.

### What it does not claim

- It does **not** say whether or when a token will be issued. There is no
  launch probability, no token supply and no price here. Implied value is a
  way to rank, not a price.
- It looks at a single seven-day window, not a history. A protocol can be up
  over seven days and down over seventy.
- Age is the day tracking began, not a signal that a launch is coming.
- The snapshot has no `parentProtocol` field, so a few rows may be
  sub-products of another protocol. Nothing here says otherwise.

## The farm plan

Every row carries eight steps, each with what it costs and how long it takes:
start with a fresh wallet; take the main position (the action follows the
protocol's category and the size follows its TVL — $50, $100, $150 or $250);
open a second surface (a second chain where the protocol runs on one, or a
second move on its main chain); do one qualifying action a week; hold for
30 to 60 days depending on age; check monthly; claim only through the
protocol's own published link; and keep a farm log. The dashboard builds the
same plan from the same rules, so the page and the board agree.

## Screenshots

Taken in a headless browser from the built dashboard, at 1440×900:

- `screenshots/1-board.png` — the ranked board
- `screenshots/2-detail.png` — one protocol's detail view, with the model
  broken down and the farm plan
- `screenshots/3-filtered.png` — the board filtered to Lending

## Files

```
main.ts                  the whole program: reads the snapshot, writes /output
vendor/makefun-board.ts  the dossier library, as the kit ships it
dashboard/index.html     the page (static, no network)
dashboard/app.css        the dark theme
dashboard/app.js         search, category and chain filters, sorting,
                         detail drawer, model panel
screenshots/              the three screenshots above
LICENSE                  MIT
```

## Checks (re-verified 2026-11-19, Node v24.22.1)

- 198 rows, watchlist 40 of 40, ranks 1–198 with no gaps, implied value
  falling as rank rises, farm steps 8 per row and 124–225 characters each.
- All seven gate rows pass (dashboard files, board file, sorted by value,
  coverage, farm steps, screenshots, dossier byte-match). The dossier is
  693,871 bytes; the dashboard source is 34,999 bytes, inside the 65,536-byte
  text cap, so the judge reads the whole source.
- Two runs, `diff -r`, byte-identical.
