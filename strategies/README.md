# BullBear Strategy Examples

This directory contains example trading strategies for BullBear.zone on Neutron. Each strategy demonstrates different approaches to automated trading on the platform.

## Available Strategies

### 1. RMM (Rapid Market Momentum)
- **Purpose**: Demo-focused strategy for immediate execution and frequent trading
- **Files**: 
  - `rmm-strategy.js` - Implementation
  - `docs/rmm-docs.md` - Documentation
  - `../run-rmm.sh` - Runner script (2-minute interval by default)
- **Key Feature**: Guaranteed trade execution with minimal barriers to entry

### 2. TFOID (Trend-Following OI Divergence)
- **Purpose**: Identifies trend continuation setups by analyzing open interest divergences
- **Files**: 
  - `tfoid-strategy.js` - Implementation
  - `docs/tfoid-docs.md` - Documentation
  - `../run-tfoid.sh` - Runner script (30-minute interval by default)
- **Key Feature**: Uses OI divergence as a trend continuation signal

## Usage

To run any strategy, use its corresponding runner script from the main directory:

```bash
# Run the RMM strategy (for fast demo purposes)
./run-rmm.sh

# Run with custom interval (60 seconds)
INTERVAL=60 ./run-rmm.sh

# Run the TFOID strategy
./run-tfoid.sh

## Strategy Development

When creating your own strategy:
1. Place your strategy implementation in this directory
2. Add documentation in the `docs` subdirectory
3. Create a runner script in the main directory

All strategies use the common utilities from `../lib.js` for interacting with the BullBear.zone platform. 