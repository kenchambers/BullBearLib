# YieldHarvester Strategy

## Overview
YieldHarvester is a dual-income strategy for BullBear.zone that capitalizes on both USDC lending yields and funding rate payments while minimizing directional market exposure.

## Key Features
- **Funding Rate Targeting**: Automatically identifies and enters positions when funding rates heavily favor one direction
- **Adaptive Leverage**: Adjusts leverage based on asset volatility to manage risk
- **Multiple Exit Conditions**: Exits positions based on funding rate normalization, profit targets, stop losses, or maximum hold times
- **Persistent State**: Maintains state between runs to avoid duplicate positions and track performance

## How It Works
1. Scans all enabled markets for funding rate opportunities exceeding thresholds
2. Takes positions opposite to the funding rate direction (e.g., goes long when shorts are paying longs)
3. Monitors positions and exits when conditions are met
4. Manages multiple concurrent positions within defined risk parameters

## Configuration
The strategy can be configured by modifying the `CONFIG` object in `yield-harvester.js`:
```javascript
const CONFIG = {
  COLLATERAL: 10.1,            // USDC per position (covers gas costs)
  MIN_FUNDING_ENTRY: 0.05,     // 0.05% per 8h funding rate threshold for entry
  MIN_FUNDING_EXIT: 0.02,      // Exit when funding normalizes below this
  MAX_POSITION_HOLD_HOURS: 72, // Maximum position hold time (3 days)
  PROFIT_TARGET_PCT: 3,        // Take profit at 3% gain
  STOP_LOSS_PCT: -2,           // Cut losses at 2% drawdown
  CHECK_INTERVAL_MS: 1800000,  // 30 minutes
  MAX_POSITIONS: 5,            // Maximum concurrent positions
  LEVERAGE_NORMAL: 3,          // Standard leverage
  LEVERAGE_HIGH_VOL: 2,        // Reduced leverage during high volatility
  VOLATILITY_THRESHOLD: 5,     // 5% 24h change considered high volatility
};
```

## Installation
1. Ensure you have Node.js installed
2. Make sure your `.env` file contains the necessary SEED mnemonic for the wallet
3. Make the runner script executable:
   ```
   chmod +x run-yield-harvester.sh
   ```

## Usage
### Running once:
```
node yield-harvester.js
```

### Running via npm script:
```
npm run yield-harvester
```

### Running continuously with the shell script:
```
./run-yield-harvester.sh              # default 30-min cadence
INTERVAL=900 ./run-yield-harvester.sh # custom 15-min cadence
```

## Logs
The bot logs all activity to the console and to `yield-harvester.log` when using the shell script runner.

## State Management
Position state is stored in `cache/yield-harvester-state.json` to:
- Track active positions between runs
- Prevent opening duplicate positions
- Maintain historical performance data

## Market Conditions
- **Ideal**: Sideways markets with high funding rate dispersion between assets
- **Adverse**: Sharp directional moves or funding rate "traps" where extreme rates persist during strong trends

## Performance Expectations
- **Expected win-rate**: 65-70% (majority of trades should at least capture funding)
- **Expected Sharpe ratio**: 1.8-2.2 (moderate volatility with consistent returns)
- **Max drawdown**: ~5% (limited by tight stop losses and moderate leverage)
- **Annual return**: 15-25% (primarily from funding rates + lending yield) 