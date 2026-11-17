/**
 * Dip-buy mean-reversion bot for cbBTC (make.fun bars-replay/v1).
 *
 * What the dev window's own numbers say (and what this bot is built on):
 * after cbBTC closes well below its half-hour mean, the next few minutes
 * usually keep sliding - the reversion only shows up over the following
 * one to two hours, and only once the fall has actually stopped. So the
 * bot buys a dip only when the close has turned back up (very deep dips
 * are bought without waiting for the turn), averages down once if the
 * dip deepens instead of reverting, and sells on a fixed gain target or
 * a time stop. A stop-loss sits far below the entry, outside the noise
 * of a normal dip, as insurance against a genuine regime break. A full
 * round trip costs roughly 20-30 bps in fees, slippage and price impact
 * depending on size, so the bot trades only dips clearly larger than
 * that.
 *
 * The bot speaks agent-fun/bars-replay/v1 directly: newline-delimited
 * JSON, one reply per batch echoing its seq. It is a pure function of
 * the bars it has seen - no clock, no files, no network, no randomness -
 * so two runs on the same window produce byte-identical orders. All
 * money amounts are the protocol's integer units (USDC quote units,
 * 6 decimals).
 */

// --- strategy parameters (basis points unless noted) -----------------------
const MEAN_BARS = 30; // bars in the mean the price reverts to
const ENTRY_BPS = 30; // buy when the close is this far below the mean ...
const DEEP_BPS = 48; // at this depth the turn-up is no longer required
const SIZE_BPS = 6000; // spend this share of cash on an entry (of 10000)
const ADD_DEV_BPS = 55; // holding and this deep: add one more tranche
const ADD_SIZE_BPS = 4000; // the added tranche's share of cash
const TP_GAIN_BPS = 60; // take-profit gain over the entry price
const STOP_BPS = 400; // stop-loss below the entry price
const MAX_HOLD = 150; // bars; time stop after this long in a position
const COOLDOWN = 30; // bars to sit out after a stop-loss
const MAX_SLIPPAGE_BPS = 200; // per-order slippage budget for the harness
const MIN_NOTIONAL = 1000000; // 1 USDC in quote units; smaller is refused

const SYMBOL = "CBBTC";

type Bar = { o: number; h: number; l: number; c: number };
type Fill = { side?: string; status?: string };
type Order = { [key: string]: string | number };

class Strategy {
  closes: number[] = [];
  qty = 0;
  ema: number | null = null;
  entryPrice: number | null = null;
  entrySeq: number | null = null;
  added = false;
  cooldownUntil = -1;
  orderSeq = 0;

  devBps(price: number): number {
    return (price / (this.ema as number) - 1.0) * 10000.0;
  }

  order(side: string, extra: { [key: string]: string }): Order {
    this.orderSeq += 1;
    const o: Order = { side, client_id: `o${this.orderSeq}`, symbol: SYMBOL };
    for (const k of Object.keys(extra)) o[k] = extra[k];
    o["max_slippage_bps"] = MAX_SLIPPAGE_BPS;
    return o;
  }

  onBatch(
    seq: number,
    bar: Bar,
    fills: Fill[],
    cash: number,
    positionQty: number,
    positionCost: number,
  ): Order[] {
    const close = bar.c;
    this.qty = positionQty;
    this.closes.push(close);
    const k = 2.0 / (MEAN_BARS + 1);
    if (this.ema === null) this.ema = close;
    else this.ema += k * (close - this.ema);

    // Track the position's life from the fills: when it opened, and
    // whether the add-on tranche has been bought.
    for (const fill of fills) {
      if (fill.status !== "filled") continue;
      if (fill.side === "buy") {
        if (this.entrySeq === null) {
          this.entrySeq = seq;
          this.added = false;
        } else {
          this.added = true;
        }
      } else if (fill.side === "sell" && positionQty === 0) {
        this.entrySeq = null;
        this.added = false;
      }
    }
    // The entry price is the account's blended cost basis:
    // quote units (1e6 per USDC) -> raw price (1e5 per USDC) is
    // price = cost * 10^(8+5) / (qty * 10^6) = cost * 10^7 / qty.
    if (positionQty > 0 && positionCost > 0) {
      this.entryPrice = (positionCost * 10000000.0) / positionQty;
    } else {
      this.entryPrice = null;
    }

    if (this.closes.length < MEAN_BARS) return []; // no history, no dip

    if (positionQty > 0) {
      const exits = this.exitOrders(seq, close);
      if (exits.length > 0) return exits;
      return this.addOrders(close, cash);
    }
    return this.entryOrders(seq, close, cash);
  }

  exitOrders(seq: number, close: number): Order[] {
    if (this.entryPrice === null) return [];
    const gainBps = (close / this.entryPrice - 1.0) * 10000.0;
    let exitNow = false;
    if (gainBps >= TP_GAIN_BPS) {
      exitNow = true; // gain target reached
    } else if (gainBps <= -STOP_BPS) {
      exitNow = true; // stop-loss
      this.cooldownUntil = seq + COOLDOWN;
    } else if (this.entrySeq !== null && seq - this.entrySeq >= MAX_HOLD) {
      exitNow = true; // time stop
    }
    if (!exitNow) return [];
    return [this.order("sell", { qty: String(this.qty) })];
  }

  addOrders(close: number, cash: number): Order[] {
    // One add-on tranche when a held dip deepens instead of reverting:
    // deeper dips carried the strongest forward returns in the dev
    // window's numbers, so the bot averages down once - never twice.
    if (this.added || this.devBps(close) > -ADD_DEV_BPS) return [];
    const notional = Math.floor((cash * ADD_SIZE_BPS) / 10000);
    if (notional < MIN_NOTIONAL) return [];
    return [this.order("buy", { notional_quote_units: String(notional) })];
  }

  entryOrders(seq: number, close: number, cash: number): Order[] {
    if (seq <= this.cooldownUntil) return [];
    const dev = this.devBps(close);
    if (dev > -ENTRY_BPS) return []; // no dip, no trade
    const prevClose = this.closes[this.closes.length - 2];
    if (dev > -DEEP_BPS && close < prevClose) return []; // still falling
    const notional = Math.floor((cash * SIZE_BPS) / 10000);
    if (notional < MIN_NOTIONAL) return [];
    return [this.order("buy", { notional_quote_units: String(notional) })];
  }
}

function main(): void {
  const strategy = new Strategy();
  let warmupBars = 0;
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");
      if (line.length > 0) handleLine(line);
    }
  });

  function handleLine(line: string): void {
    const msg = JSON.parse(line);
    const kind = msg.type;
    if (kind === "hello") {
      warmupBars = Number(msg.warmup_bars ?? 0);
      return;
    }
    if (kind === "done") {
      process.exit(0);
    }
    if (kind !== "batch") return;
    const seq = Number(msg.seq);
    const account = msg.account;
    const cash = Number(account.cash_quote_units);
    let positionQty = 0;
    let positionCost = 0;
    for (const pos of account.positions) {
      if (pos.symbol === SYMBOL) {
        positionQty = Number(pos.qty);
        positionCost = Number(pos.cost_quote_units);
      }
    }
    let bar: Bar | null = null;
    for (const raw of msg.bars) {
      if (raw.symbol === SYMBOL) {
        bar = { o: Number(raw.o), h: Number(raw.h), l: Number(raw.l), c: Number(raw.c) };
      }
    }
    let orders: Order[] = [];
    if (bar !== null && seq >= warmupBars) {
      orders = strategy.onBatch(seq, bar, msg.fills ?? [], cash, positionQty, positionCost);
    }
    process.stdout.write(JSON.stringify({ type: "reply", seq, orders }) + "\n");
  }
}

main();
