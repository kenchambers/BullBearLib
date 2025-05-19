# Liquidity Imbalance Tracker (LIT) Strategy

## Strategy Overview

The Liquidity Imbalance Tracker identifies and capitalizes on significant liquidity imbalances in perpetual futures markets. It monitors open interest ratios and funding rates to detect market concentrations, then takes positions counter to extreme market sentiment.

## Key Insight

Markets often become imbalanced when too many traders pile into the same position direction. This creates:

1. Skewed funding rates that benefit the contrarian position
2. Technical setup for a potential market reversal (crowded trades unwind)
3. Profitable opportunities by positioning against market extremes

## Technical Indicators

- **Open Interest Ratio**: Measures the imbalance between long and short positions
- **Funding Rate**: Shows which side is paying the other (high positive = longs pay shorts)
- **Imbalance Score**: Proprietary metric combining OI ratio and funding rate
- **Dynamic Leverage**: Calibrates position sizing based on signal strength

## Strategy Logic

### Entry Criteria

- Open Interest Ratio exceeds 2.0 (one side is at least twice as large as the other)
- Funding Rate supports the contrarian position (>15% annualized)
- Asset isn't blacklisted from previous failures
- Maximum positions limit not yet reached (default: 3)

### Position Sizing

- Base collateral: 10.1 USDC per position
- Base leverage: 2.5x
- Dynamic leverage adjustment:
  - Increases to 3.0x (1.2x multiplier) when imbalance ratio > 3 or funding rate > 25%
  - Increases to 3.75x (1.5x multiplier) when imbalance ratio > 5 or funding rate > 40%
  - Never exceeds platform-imposed maximum or 5x (safety cap)

### Exit Logic

- Take profit: 3% position profit
- Stop loss: 4% position loss
- Maximum hold time: 24 hours
- Market normalization: Exit when imbalance conditions normalize

## Market Conditions

### Favorable Conditions

- Sideways or ranging markets with oscillating price action
- High funding rate environments
- Markets with persistent imbalances between longs and shorts
- High liquidity assets where position entry/exit is reliable

### Challenging Conditions

- Strong directional trends (even contrarian positions can face drawdown)
- Extreme volatility causing rapid price changes
- Low liquidity assets with wide spreads
- Market disruptions affecting normal funding rate mechanics

## Implementation Details

### State Management

- Persistent position tracking across runs
- Blacklisting problematic assets
- Error handling with retry mechanism

### Risk Management

- Conservative leverage (2.5x base)
- Strict stop losses (4%)
- Position diversification (up to 3 concurrent positions)
- Blacklisting mechanism for problematic assets

## Usage

```bash
# One-time execution
node strategies/liquidity-imbalance-tracker.js

# Continuous execution with default 30-min interval
cd runners
chmod +x run-lit.sh
./run-lit.sh

# Custom interval (15 minutes)
INTERVAL=900 ./run-lit.sh
```

## Performance Expectations

- Win rate: ~55-60%
- Average profit per winning trade: 2-3%
- Average loss per losing trade: 2-4%
- Expected Sharpe ratio: 1.2-1.5
- Maximum drawdown: 10-15%

The strategy performs best in sideways or choppy markets where funding rates remain elevated and price oscillates within a range.
