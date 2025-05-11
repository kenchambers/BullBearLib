# BullBear Trading Strategies

This repository contains SDK and sample trading strategies for BullBear.zone on Neutron.

## Quick Start

```bash
# Install dependencies
npm install

# Run the RMM strategy (best for demo purposes - runs every 2 minutes)
./run-rmm.sh

# Run other strategies
./run-tfoid.sh
```

## Repository Structure

- `lib.js` - Core trading SDK with wallet loading, price & funding queries, position management
- `consts.js` - Configuration constants
- `strategies/` - Sample trading strategies
  - See [Strategies README](strategies/README.md) for details on each strategy
- `run-*.sh` - Runner scripts for continuous execution of strategies

## Available Strategies

1. **RMM (Rapid Market Momentum)** - Demo-focused strategy that opens trades frequently with minimal barriers
2. **TFOID (Trend-Following OI Divergence)** - Identifies trend continuation setups using open interest divergence
3. **SMART (Semantic Multi-Narrative Arbitrage Trader)** - Trading strategy based on funding rate opportunities

## Implementation Requirements

All strategies follow these requirements:
- Minimum 10 USDC collateral per trade
- Asset payload as balanced long-short pair with percentages summing to 1.0
- Trading only enabled assets via `getMarkets()`
- Proper RPC error handling
- State persistence for tracking positions
- Configurable exit logic

## Development

To create your own strategy:
1. Add your strategy file to the `strategies/` directory
2. Create a runner script that executes the strategy on a loop
3. Add documentation in `strategies/docs/`

Refer to the existing examples for the proper implementation pattern.