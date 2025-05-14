# Funding Rate Arbitrage (FRA) Strategy

## Overview

The Funding Rate Arbitrage (FRA) strategy captures yield from perpetual futures markets by trading based on funding rate opportunities. It identifies assets with extreme funding rates and enters positions to earn funding payments while managing risk.

## Strategy Logic

### Core Concept
- Capture assets with extreme funding rates
- Go long on negative funding (shorts pay longs)
- Go short on positive funding (longs pay shorts)
- Use single-asset positions to maximize funding yield
- Exit when funding rates normalize or upon reaching profit/loss targets

### Entry Criteria
- Funding rate exceeds minimum threshold (default: 15% annualized)
- Open interest imbalance exceeds minimum ratio (default: 1.2x)
- Asset not currently on blacklist
- Position limit not reached (default: 3 concurrent positions)

### Exit Criteria
- Funding rate normalizes below exit threshold (default: 5% annualized)
- Position reaches take profit threshold (default: 5%)
- Position hits stop loss threshold (default: 3%)
- Maximum hold time reached (default: 48 hours)

### Risk Management
- Uses moderate leverage (default: 2x)
- Implements strict stop loss for downside protection
- Enforces maximum position count
- Blacklists recently closed assets to prevent churn

## Configuration Parameters

```javascript
const CONFIG = {
  // Strategy parameters
  COLLATERAL: 10.1, // USDC collateral per trade (slightly above $10 min to cover gas)
  LEVERAGE: "2", // Moderate leverage for controlled risk
  MAX_POSITIONS: 3, // Maximum concurrent positions
  
  // Entry conditions
  MIN_FUNDING_RATE_ENTRY: 15, // Minimum absolute funding rate (annualized %) to enter
  MIN_OI_IMBALANCE: 1.2, // Minimum OI imbalance ratio (higher side / lower side)
  
  // Exit conditions
  MIN_FUNDING_RATE_EXIT: 5, // Exit when funding rate falls below this threshold
  TAKE_PROFIT_PERCENT: 0.05, // 5% profit target
  STOP_LOSS_PERCENT: 0.03, // 3% stop loss
  MAX_POSITION_HOURS: 48, // Maximum hold time (2 days)
  
  // Operational settings
  BLACKLIST_HOURS: 6, // Hours to blacklist an asset after closing
  DRY_RUN: false, // Set to true to simulate without trading
  DEBUG: true, // Show extra debug info
};
```

## Running the Strategy

You can run the strategy using the runner script:

```bash
./runners/run-fra.sh
```

To change the execution interval:

```bash
INTERVAL=900 ./runners/run-fra.sh  # Run every 15 minutes
```

## State Management

The strategy maintains state across runs:

- Active positions with entry prices and funding rates
- Asset blacklist to prevent immediate re-entry
- Trade history for performance analysis

## Behavior

When executed, the strategy:

1. Connects to BullBear.zone via lib.js
2. Loads previous state from cache
3. Retrieves current market data (prices, funding rates)
4. Manages existing positions (check exit criteria)
5. Finds new opportunities based on current funding rates
6. Opens new positions if good opportunities exist
7. Saves updated state

## Dependencies

- ../lib.js - Core trading functions
- ../consts.js - System constants 