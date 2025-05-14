# BullBearLib Strategies

This directory contains trading strategies for BullBear.zone on Neutron. Each strategy is designed to capitalize on different market conditions and follows a specific trading methodology.

## Available Strategies

| Strategy | Description | Documentation |
|----------|-------------|---------------|
| Funding Rate Arbitrage (FRA) | Captures funding rate differentials by taking positions that earn funding fees | [FRA Docs](./fra-docs.md) |
| Momentum Breakout Follower (MBF) | Follows price breakouts with momentum confirmation | [MBF Docs](./mbf-docs.md) |
| Yield Harvester (YH) | Captures funding rate yield from positions with extreme funding rates | [YH Docs](./yh-docs.md) |
| Volatility Breakout Hunter (VBH) | Identifies and trades high volatility breakouts | [VBH Docs](./vbh-docs.md) |
| Funding Skew Reversal (FSR) | Identifies assets with funding rates misaligned with price action | [FSR Docs](./fsr-strategy-docs.md) |

## Strategy Execution

All strategies can be executed using their respective runner scripts in the `runners/` directory:

```bash
# Run Funding Rate Arbitrage strategy
./runners/run-fra.sh

# Run Momentum Breakout Follower strategy
./runners/run-mbf.sh

# Run Yield Harvester strategy
./runners/run-yield.sh

# Run Volatility Breakout Hunter strategy
./runners/run-vbh.sh

# Run Funding Skew Reversal strategy
./runners/run-fsr.sh
```

## Creating New Strategies

When creating a new strategy, follow this structure:

1. Create a strategy file in this directory (e.g., `strategies/my-strategy.js`)
2. Create documentation in this directory (e.g., `strategies/my-strategy-docs.md`)
3. Create a runner script in the `runners/` directory (e.g., `runners/run-my-strategy.sh`)
4. Update this README to include your strategy

## Dependencies

All strategies depend on:
- Core trading functions from `../lib.js`
- Constants from `../consts.js`
- Environment variables from `../.env` 