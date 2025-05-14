# BullBearLib

BullBearLib is a collection of trading strategies and utilities for [BullBear.zone](https://www.bullbear.zone/), a Perpetual DEX on Neutron.

## Repository Structure

- **strategies/** - Trading strategy implementations
- **runners/** - Shell scripts for running strategies continuously
- **logs/** - Log output from strategy runs
- **cache/** - Cached data and strategy state
- **lib.js** - Core trading functions for BullBear.zone
- **consts.js** - System constants

## Available Strategies

| Strategy | Description | Documentation |
|----------|-------------|---------------|
| Funding Rate Arbitrage (FRA) | Captures funding rate differentials | [FRA Docs](strategies/fra-docs.md) |
| Momentum Breakout Follower (MBF) | Follows price breakouts with momentum | [MBF Docs](strategies/mbf-docs.md) |
| Yield Harvester (YH) | Captures funding rate yield from extreme markets | [YH Docs](strategies/yh-docs.md) |
| Volatility Breakout Hunter (VBH) | Trades high volatility breakouts | [VBH Docs](strategies/vbh-docs.md) |
| Funding Skew Reversal (FSR) | Trades assets with misaligned funding rates | [FSR Docs](strategies/fsr-strategy-docs.md) |

## Getting Started

1. Install dependencies:
   ```bash
   npm install
   ```

2. Set up your environment variables:
   ```bash
   # Create .env file with your mnemonic seed
   echo "SEED=your mnemonic seed phrase here" > .env
   ```

3. Run a strategy:
   ```bash
   # Run the Funding Rate Arbitrage strategy
   ./runners/run-fra.sh
   ```

## Strategy Execution

Each strategy can be run using its respective runner script:

```bash
# Run with default settings (30-minute interval)
./runners/run-fra.sh

# Run with custom interval (in seconds)
INTERVAL=900 ./runners/run-mbf.sh  # Run every 15 minutes

# You can also run from within the runners directory
cd runners
./run-fra.sh
```

## Creating New Strategies

See [strategies/README.md](strategies/README.md) for information on creating and documenting new strategies.

## License

This repository is provided for educational purposes only. Use at your own risk.

## Acknowledgements

This library uses the BullBear.zone API as documented in [bullBear.md](bullBear.md).