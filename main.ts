// Token Radar: rank pre-token protocols by the value a token would imply.
//
// The program reads one sealed snapshot of DeFi protocols (DefiLlama), scores
// every protocol that has no token yet, and writes a ranked board plus the
// compact data file a small dashboard page reads. It also copies the page and
// its screenshots into the output directory and writes the dossier the judge
// reads, using the kit's own dossier library.
//
// Scoring, in plain terms: a protocol's implied value starts from its total
// value locked, grows or shrinks with its last seven days, is adjusted for how
// long it has been listed, and is lifted a little for each extra chain it runs
// on. The board carries every protocol that passes the filters, the snapshot's
// watchlist first among them, and a second list holds the largest live tokens
// for contrast. Each board row also carries an eight-step farming plan: what a
// reader would actually do, with what capital, on which chain, for how long.
//
// Run it as:  MAKEFUN_OUTPUT_DIR=out node main.ts --input snapshot.json
//
// Model notes (radar-2), for a reader of this file. The implied value of a
// protocol is built from four parts, all taken from the snapshot alone:
//
//   - A tiered base from total value locked: the first $1B counts at 0.25
//     per dollar and anything above it at 0.10, so a very large protocol is
//     not credited at the full multiple on every dollar.
//   - A growth part from the seven-day change, clamped to -60% .. +150%.
//     Rises are weighted 0.70 and falls 0.30, because a rising TVL is the
//     stronger sign. A missing seven-day figure counts as flat.
//   - An age part from the listing date. It climbs from 0.75 to 1.00 over
//     the first 90 days, keeps climbing to 1.05 at three years, then eases
//     back by 0.15 and holds there. A missing listing date counts as 365 days.
//   - A chain part: 1 + 0.04 for each chain past the first, capped at four
//     extra chains, so a protocol on dozens of chains cannot run away.
//
//   implied = round(base x growth x age x chain)
//
// The board admits a protocol only when it records no token at all (no
// market cap, no CoinGecko id, no symbol), its category is not Bridge,
// Canonical Bridge, Liquid Staking, Liquid Restaking, Restaked BTC or CEX,
// and its name carries no whole word wrapped / staked / staking, starts with
// no exchange's name, and ends with no version marker. The board is every
// protocol that passes, ranked by implied value, with the snapshot's
// watchlist flagged among them. A separate list holds the 24 largest live
// tokens by market cap, exchanges left out, for contrast.
//
// Each row also carries an eight-step farming plan. The main position's size
// follows TVL ($50 under $100M, $100 under $1B, $150 under $5B, $250 above),
// the gas follows the position's size, the second step uses a second chain
// when there is one, and the hold runs 60 days under 180 days of age, 45
// days under a year, and 30 days beyond that.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

// ------------------------------------------------------------------ model
//
// The scoring constants. They are the model's parameters, stated once here so
// the board and the dashboard's data file always agree about them.

const BASE_BELOW = 0.25; // value per dollar of TVL up to the tier
const BASE_TIER_USD = 1_000_000_000; // the tier where the multiple steps down
const BASE_ABOVE = 0.1; // value per dollar of TVL past the tier
const GROWTH_UP = 0.7; // weight on a positive seven-day move
const GROWTH_DOWN = 0.3; // weight on a negative seven-day move
const GROWTH_FLOOR = -60; // seven-day moves are clamped to this, in percent
const GROWTH_CAP = 150; // ... and to this, in percent
const AGE_FLOOR = 0.75; // the youngest protocols start here
const AGE_PEAK = 1.05; // the multiplier at its highest, at AGE_PEAK_DAYS
const AGE_PEAK_DAYS = 1095; // three years, where the multiplier peaks
const AGE_RAMP_DAYS = 90; // the multiplier reaches 1.00 after this many days
const AGE_DECAY = 0.15; // how much the multiplier eases off after the peak
const UNKNOWN_AGE_DAYS = 365; // a protocol with no listing date counts as this old
const CHAIN_STEP = 0.04; // extra multiplier per chain beyond the first
const CHAIN_MAX_STEPS = 4; // the chain lift is capped at this many extra chains
const MODEL_VERSION = 'radar-2';
const LIVE_COUNT = 24; // how many live tokens the contrast list holds

// ------------------------------------------------------------------ filters
//
// Which protocols the board admits. A protocol joins the board when it has no
// token at all, its category is not one of the excluded kinds, and its name
// does not look like a wrapped or staked derivative, a versioned re-listing,
// or an exchange's own listing.

const EXCLUDED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

const BLOCKED_NAME_WORDS = ['wrapped', 'staked', 'staking'];

const EXCHANGE_NAMES = new Set([
  'binance', 'coinbase', 'okx', 'kraken', 'bybit', 'kucoin', 'bitstamp',
  'gemini', 'huobi', 'htx', 'bitfinex', 'deribit', 'bitmex', 'gate',
  'mexc', 'nexo', 'backpack', 'swissborg', 'bitget', 'upbit', 'bithumb',
]);

// ------------------------------------------------------------------ farm plan
//
// What a reader would spend and how long each step takes. The main position's
// size follows the protocol's TVL; the gas follows the position's size.

function capitalFor(tvlUsd: number): number {
  if (tvlUsd < 100_000_000) return 50;
  if (tvlUsd < 1_000_000_000) return 100;
  if (tvlUsd < 5_000_000_000) return 150;
  return 250;
}

function gasFor(capitalUsd: number): number {
  return capitalUsd >= 150 ? 8 : 4;
}

function holdDaysFor(ageDays: number | null): number {
  const age = ageDays ?? UNKNOWN_AGE_DAYS;
  if (age < 180) return 60;
  if (age < UNKNOWN_AGE_DAYS) return 45;
  return 30;
}

// ------------------------------------------------------------------ shapes

interface SnapshotProtocol {
  category: string;
  chains: string[];
  change_7d: number | null;
  gecko_id: string | null;
  listed_at: string | null;
  mcap_usd: number | null;
  name: string;
  slug: string;
  symbol: string | null;
  tvl_usd: number;
}

interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

interface ModelDetail {
  base_multiple: number;
  growth_pct: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  chain_multiplier: number;
  age_days: number | null;
}

interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: string;
  age_days: number | null;
  implied_value_usd: number;
  model: ModelDetail;
  farm_steps: string[];
}

interface LiveEntry {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
}

// ------------------------------------------------------------------ scoring

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

// Days between two YYYY-MM-DD dates, counted in UTC so the result does not
// depend on the machine's timezone. A protocol with no listing date has no
// age; the maturity step below substitutes the unknown-age default.
function ageInDays(asOf: string, listedAt: string | null): number | null {
  if (!listedAt) return null;
  const start = Date.parse(listedAt + 'T00:00:00Z');
  const end = Date.parse(asOf + 'T00:00:00Z');
  return Math.round((end - start) / 86400000);
}

// How long a protocol has been listed lifts or lowers its implied value.
// Young protocols climb from the floor to 1.00 over the ramp, then keep
// climbing gently to the peak at three years, then ease back down by the
// decay amount and hold there.
function maturityFor(ageDays: number | null): number {
  const age = ageDays ?? UNKNOWN_AGE_DAYS;
  if (age < AGE_RAMP_DAYS) return AGE_FLOOR + (1 - AGE_FLOOR) * (age / AGE_RAMP_DAYS);
  if (age <= AGE_PEAK_DAYS) return 1 + (AGE_PEAK - 1) * ((age - AGE_RAMP_DAYS) / (AGE_PEAK_DAYS - AGE_RAMP_DAYS));
  return Math.max(AGE_PEAK - AGE_DECAY, AGE_PEAK - AGE_DECAY * ((age - AGE_PEAK_DAYS) / AGE_PEAK_DAYS));
}

// The seven-day move, clamped, then weighted: rises count more than falls.
// A protocol with no seven-day figure counts as flat.
function growthFor(change7d: number | null): { pct: number; multiplier: number } {
  if (change7d === null || change7d === undefined) return { pct: 0, multiplier: 1 };
  const pct = Math.min(GROWTH_CAP, Math.max(GROWTH_FLOOR, change7d));
  const multiplier = 1 + (GROWTH_UP * Math.max(pct, 0) + GROWTH_DOWN * Math.min(pct, 0)) / 100;
  return { pct, multiplier };
}

// Each chain beyond the first lifts the value a little, up to the cap.
function chainFactor(chains: string[]): number {
  return 1 + CHAIN_STEP * Math.min(chains.length - 1, CHAIN_MAX_STEPS);
}

// The starting value: the lower multiple applies up to the tier, the higher
// multiple only to what sits above it, so a very large protocol is not
// credited at the full multiple on every dollar.
function baseValue(tvlUsd: number): number {
  return BASE_BELOW * Math.min(tvlUsd, BASE_TIER_USD) + BASE_ABOVE * Math.max(tvlUsd - BASE_TIER_USD, 0);
}

// ------------------------------------------------------------------ eligibility

function hasToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd !== null && p.mcap_usd !== undefined
    || p.gecko_id !== null && p.gecko_id !== undefined
    || p.symbol !== null && p.symbol !== undefined;
}

function nameBlocked(name: string): boolean {
  const lower = name.toLowerCase();
  for (const word of BLOCKED_NAME_WORDS) {
    if (new RegExp('\\b' + word + '\\b', 'i').test(lower)) return true;
  }
  const words = name.trim().split(/\s+/);
  const last = words[words.length - 1];
  if (/^v\d+$/i.test(last)) return true;
  if (/\s\d+\.\d+$/.test(name)) return true;
  const first = words[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  if (EXCHANGE_NAMES.has(first)) return true;
  return false;
}

function eligible(p: SnapshotProtocol): boolean {
  if (hasToken(p)) return false;
  if (EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (nameBlocked(p.name)) return false;
  return true;
}

// Score one protocol into a board row (without its rank, which depends on
// the whole board's order, and without its farm plan, which is built next).
function scoreProtocol(p: SnapshotProtocol, asOf: string): Omit<BoardRow, 'rank' | 'farm_steps'> {
  const age = ageInDays(asOf, p.listed_at);
  const growth = growthFor(p.change_7d);
  const maturity = maturityFor(age);
  const chain = chainFactor(p.chains);
  const implied = Math.round(baseValue(p.tvl_usd) * growth.multiplier * maturity * chain);
  return {
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: [...p.chains],
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    mcap_usd: p.mcap_usd,
    listed_at: p.listed_at,
    gecko_id: p.gecko_id,
    symbol: p.symbol,
    token_status: 'pre-token',
    age_days: age,
    implied_value_usd: implied,
    model: {
      base_multiple: BASE_BELOW,
      growth_pct: growth.pct,
      growth_multiplier: round4(growth.multiplier),
      maturity_multiplier: round4(maturity),
      chain_multiplier: round4(chain),
      age_days: age,
    },
  };
}

// ------------------------------------------------------------------ farm plan

// The main position's wording follows what the protocol actually does: a
// lender is supplied, a market is given liquidity, a stablecoin is minted,
// a stake is staked. The two vault-style categories name the vault.
function mainPosition(category: string, name: string, capital: number, chain: string): string {
  switch (category) {
    case 'CDP':
    case 'CDP Manager':
    case 'Collateral Markets':
    case 'Lending':
    case 'Uncollateralized Lending':
      return `Supply $${capital} to ${name} on ${chain} and leave it there to work.`;
    case 'Dexs':
    case 'Indexes':
    case 'Leveraged Farming':
    case 'Yield':
    case 'Yield Aggregator':
      return `Add $${capital} of liquidity to ${name}'s pool on ${chain} and leave it there to work.`;
    case 'Dual-Token Stablecoin':
    case 'RWA':
    case 'Stablecoin Wrapper':
      return `Mint $${capital} worth of ${name} on ${chain} and hold it for the farm.`;
    case 'Restaking':
    case 'Staking Pool':
      return `Stake $${capital} with ${name} on ${chain} and leave it staked for the farm.`;
    case 'Insurance':
      return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`;
    case 'Cross Chain Bridge':
      return `Bridge $${capital} with ${name} and keep the funds on the destination chain.`;
    case 'Prediction Market':
      return `Fund a $${capital} position on ${name} and leave it open for the farm.`;
    case 'Onchain Capital Allocator':
    case 'Risk Curators':
      return `Put $${capital} into a ${name} vault on ${chain} and leave the shares there to work.`;
    default:
      return `Put $${capital} into ${name} on ${chain} and leave it there to work.`;
  }
}

// The second surface: a second chain when the protocol runs on one, otherwise
// a second move on the same chain, so the farm is never a single deposit.
function secondSurface(row: Omit<BoardRow, 'rank' | 'farm_steps'>): string {
  if (row.chains.length >= 2) {
    return `Do the same on ${row.chains[1]} with $25, so the farm spans two chains.`;
  }
  return `Put a second $25 into ${row.name} on ${row.chains[0]} through a different pool or action, so the farm is not a single deposit.`;
}

// Eight steps, each carrying its own cost and time, so a reader can follow
// the plan without guessing what anything costs.
function farmPlan(row: Omit<BoardRow, 'rank' | 'farm_steps'>): string[] {
  const capital = capitalFor(row.tvl_usd);
  const gas = gasFor(capital);
  const chain = row.chains[0];
  const hold = holdDaysFor(row.age_days);
  return [
    `Open a fresh wallet that holds only the money you plan to farm, and keep its seed phrase offline on paper. Cost: less than $3 in gas. Time: 5 minutes.`,
    `${mainPosition(row.category, row.name, capital, chain)} Cost: $${capital} in capital and roughly $${gas} in gas. Time: 15 minutes to set up.`,
    `${secondSurface(row)} Cost: $25 in capital and roughly $3 in gas. Time: 10 minutes to set up.`,
    `Do one qualifying action every week, such as a deposit, a borrow, a swap or a vote, so the wallet stays active. Cost: roughly $2 in gas each week. Time: 10 minutes a week.`,
    `Keep the position open for at least ${hold} days, so the activity shows up in more than one snapshot. Cost: the $${capital} stays in the position. Time: ${hold} days.`,
    `Once a month, check whether the position is still earning and whether a pool or vault on ${chain} pays more for the same capital. Cost: free to check; roughly $3 in gas only if you move it. Time: 15 minutes a month.`,
    `Before you pull out, open the protocol's own points or rewards page and claim only through the link it publishes. Cost: free to check; never pay anyone to claim. Time: 10 minutes.`,
    `Write the wallet, the dates and every transaction in a farm log, so you can repeat the position or unwind it. Cost: nothing but the log itself. Time: 5 minutes.`,
  ];
}

// ------------------------------------------------------------------ live list

// The contrast list: the largest live tokens by market cap, exchanges left
// out, so the reader can see what a token is worth once it exists.
function buildLive(protocols: SnapshotProtocol[]): LiveEntry[] {
  return protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd !== undefined && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd as number) - (a.mcap_usd as number))
    .slice(0, LIVE_COUNT)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: [...p.chains],
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd as number,
      change_7d: p.change_7d,
    }));
}

// ------------------------------------------------------------------ outputs

function copyDir(src: string, dest: string): string[] {
  mkdirSync(dest, { recursive: true });
  const names = readdirSync(src).filter((n) => !n.startsWith('.')).sort();
  for (const name of names) copyFileSync(join(src, name), join(dest, name));
  return names;
}

function main(): void {
  const args = process.argv.slice(2);
  const inputFlag = args.indexOf('--input');
  const inputPath = inputFlag >= 0 && args[inputFlag + 1] ? args[inputFlag + 1] : '/input/snapshot.json';
  const outDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';
  const root = dirname(fileURLToPath(import.meta.url));

  const snapshot: Snapshot = JSON.parse(readFileSync(inputPath, 'utf8'));
  const watchlist = new Set(snapshot.watchlist);

  const scored = snapshot.protocols.filter(eligible).map((p) => scoreProtocol(p, snapshot.as_of));
  scored.sort((a, b) => b.implied_value_usd - a.implied_value_usd);
  const rows: BoardRow[] = scored.map((row, i) => ({
    rank: i + 1,
    ...row,
    farm_steps: farmPlan(row),
  }));
  const early = rows.filter((r) => !watchlist.has(r.slug)).length;
  const live = buildLive(snapshot.protocols);

  mkdirSync(outDir, { recursive: true });
  const boardPath = join(outDir, 'board.json');
  writeFileSync(boardPath, JSON.stringify({ rows }) + '\n');

  const dataRows = rows.map((r) => ({
    rank: r.rank,
    slug: r.slug,
    name: r.name,
    category: r.category,
    chains: [...r.chains],
    tvl_usd: r.tvl_usd,
    change_7d: r.change_7d,
    mcap_usd: r.mcap_usd,
    listed_at: r.listed_at,
    age_days: r.age_days,
    watchlist: watchlist.has(r.slug),
    implied_value_usd: r.implied_value_usd,
    growth_multiplier: r.model.growth_multiplier,
    maturity_multiplier: r.model.maturity_multiplier,
    chain_multiplier: r.model.chain_multiplier,
  }));
  const data = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: {
      base_multiple: BASE_BELOW,
      base_tier_usd: BASE_TIER_USD,
      base_multiple_above: BASE_ABOVE,
      growth_weight_up: GROWTH_UP,
      growth_weight_down: GROWTH_DOWN,
      growth_floor: GROWTH_FLOOR,
      growth_cap: GROWTH_CAP,
      maturity_floor: AGE_FLOOR,
      maturity_peak: AGE_PEAK,
      maturity_days: AGE_PEAK_DAYS,
      maturity_decay: AGE_DECAY,
      unknown_age_days: UNKNOWN_AGE_DAYS,
      chain_step: CHAIN_STEP,
      chain_max_steps: CHAIN_MAX_STEPS,
    },
    model_version: MODEL_VERSION,
    watchlist_size: watchlist.size,
    board_size: rows.length,
    early_size: early,
    live_size: live.length,
    rows: dataRows,
    live,
  };
  const dataPath = join(outDir, 'data.js');
  writeFileSync(dataPath, 'window.RADAR=' + JSON.stringify(data) + ';\n');

  const dashFiles = copyDir(join(root, 'dashboard'), join(outDir, 'dashboard'));
  const shotFiles = copyDir(join(root, 'screenshots'), join(outDir, 'screenshots'));

  const dossier = buildDossier(outDir, { text_max_bytes: 65536 });
  const dossierPath = join(outDir, 'dossier.json');
  writeFileSync(dossierPath, dossier);

  console.log(`token radar: ${snapshot.protocols.length} protocols, ${watchlist.size} on the watchlist, ${rows.length} rows scored (${early} early, ${live.length} live set aside)`);
  console.log(`token radar: wrote ${boardPath}, ${dataPath}, ${join(outDir, 'dashboard')} (${dashFiles.length} files), ${join(outDir, 'screenshots')} (${shotFiles.length} images) and ${dossierPath}`);
}

main();
