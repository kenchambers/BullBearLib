# BullBearLib Strategy Runners

This directory contains shell scripts that run the various trading strategies at configurable intervals. Each runner script:

1. Sets up logging
2. Executes the strategy at regular intervals
3. Handles and logs errors appropriately

## Available Runners

| Runner | Strategy | Default Interval | Log Location |
|--------|----------|-----------------|--------------|
| run-fra.sh | Funding Rate Arbitrage | 30 minutes | ./logs/fra-YYYYMMDD.log |
| run-mbf.sh | Momentum Breakout Follower | 30 minutes | ./logs/mbf-YYYYMMDD.log |
| run-yield.sh | Yield Harvester | 30 minutes | ./logs/yield-YYYYMMDD.log |
| run-vbh.sh | Volatility Breakout Hunter | 30 minutes | ./logs/vbh-YYYYMMDD.log |
| run-fsr.sh | Funding Skew Reversal | 30 minutes | ./logs/fsr-YYYYMMDD.log |

## Usage

Run any strategy with:

```bash
# From the root directory
./runners/run-fra.sh

# Or from within the runners directory
cd runners
./run-fra.sh

# Run with custom interval (in seconds)
INTERVAL=600 ./runners/run-fra.sh  # Run every 10 minutes
```

The scripts will automatically detect their location and ensure they have access to the necessary files in the root directory (.env, lib.js, etc.)

## Customization

Each runner script accepts the following environment variables:

- `INTERVAL`: Time between strategy executions in seconds (default: 1800 - 30 minutes)
- `DEBUG`: Set to "true" for additional debug output (if supported by the strategy)

## Creating New Runners

When creating a new runner for a strategy:

1. Copy one of the existing runners as a template
2. Update the paths to point to your strategy file
3. Set appropriate default parameters for your strategy
4. Update this README to include your new runner 