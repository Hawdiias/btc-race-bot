# cbBTC Dip-Buyer — BTC Race 24h

A mean-reversion trading bot for the make.fun "Race a BTC trading bot
live for 24 hours" bounty (harness agent-fun/bars-replay/v1). It trades
Coinbase Wrapped BTC (cbBTC) against USDC on 1-minute on-chain bars with
$1,000 of paper money. Simulation only — no real money is traded.

## Strategy

cbBTC spends most minutes oscillating around a slow intraday mean, and a
round trip costs roughly 20–30 bps in fees, slippage and price impact,
so the bot only trades dips clearly larger than the cost of trading
them:

- **Entry** — the close falls at least 30 bps below its 30-bar
  exponential mean *and* stops making new lows (very deep dips, 48+ bps,
  are bought without waiting for the turn). 60% of cash is deployed.
- **Add-on** — if a held dip deepens to 55 bps below the mean instead of
  reverting, one more tranche (40% of remaining cash) averages down.
  Deeper dips carried the strongest forward returns in the dev window's
  data; the bot adds once, never twice.
- **Exits** — a fixed +60 bps gain target over the blended entry cost,
  a 150-bar time stop for positions whose reversion never came, and a
  −400 bps stop-loss that sits far outside dip noise as insurance
  against a genuine regime break. A stop-loss starts a 30-bar cooldown.

The bot is a pure function of the bars it has seen: no clock, no files,
no network, no randomness — two runs on the same window produce
byte-identical orders.

## Running

The harness runs it as `node main.ts` (Node 22, type stripping,
standard library only). It reads newline-delimited JSON
(hello / batch / done) on stdin and writes one reply per batch on
stdout.

Dev-window grade (kit's own harness): net PnL **+$12.22** on $1,000
(10 trades, max drawdown 0.84%; +$10.02 with every fee doubled), which
clears the dev gate (net PnL above $0) with room to spare.

## License

MIT — see LICENSE.
