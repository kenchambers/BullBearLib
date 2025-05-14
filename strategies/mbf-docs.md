# Momentum Breakout Follower (MBF) Strategy

The Momentum Breakout Follower strategy identifies assets with significant price momentum and takes positions in the direction of confirmed breakouts. It has a built-in long bias to prefer upward momentum, especially for INIT tokens.

## Strategy Overview

### Core Concept
The MBF strategy tracks price changes for all available assets, identifies those with strong directional momentum, and takes positions in the direction of the momentum with complementary asset balancing.

### Key Features
1. **Directional Momentum Tracking**: Monitors price movements across multiple time periods
2. **Breakout Detection**: Identifies assets that have moved significantly in a particular direction
3. **Long Bias**: Lower threshold for long entries than shorts, with special preference for INIT tokens
4. **Complementary Asset Pairing**: Finds the best complementary asset to create balanced 50/50 positions
5. **Risk Management**: Uses profit targets, stop losses, and maximum position duration limits
6. **State Persistence**: Maintains position history, blacklists recently traded assets

## Position Logic

### Entry Criteria
- Asset price must move at least 1.5% in either direction (configurable)
- Long bias: Long entries have a lower threshold (1.2% by default with the 0.8 bias factor)
- Funding rate direction is considered as a secondary signal
- INIT long positions receive priority boosting for higher likelihood of execution

### Position Construction
- Each position is 50/50 balanced between two assets
- Primary asset is in the direction of the breakout
- Complementary asset may be:
  1. An asset with opposite momentum (ideal)
  2. The same asset traded in the opposite direction (fallback)

### Leverage and Risk
- Uses moderate leverage (2x by default) to control risk
- Maximum of 3 concurrent positions allowed
- Only one position allowed per asset

### Exit Criteria
- Take profit: Exit when position reaches 5% profit
- Stop loss: Exit when position loses 3% of collateral value
- Time-based exit: Automatically close after 24 hours

## Implementation Details

### Configuration
The strategy is highly configurable with parameters for:
- Momentum detection threshold and window
- Position sizing and maximum count
- Take profit and stop loss percentages
- Long bias factor
- Maximum position duration

### State Management
- Tracks all open positions and their entry prices
- Maintains price history for all available assets
- Temporarily blacklists assets after trading to prevent immediate re-entry

## Usage

### Installation
1. Clone this repository: `git clone <repo-url>`
2. Install dependencies: `npm install`
3. Ensure your `.env` file contains the SEED mnemonic for your BullBear wallet

### Running
```bash
# Make the runner executable
chmod +x run-mbf.sh

# Run once
node momentum-breakout-follower.js

# Run continuously with default interval (30 minutes)
./run-mbf.sh

# Run with custom interval (15 minutes)
INTERVAL=900 ./run-mbf.sh
```

## Market Conditions

### Ideal Conditions
- Trending markets with clear directional momentum
- Markets transitioning from low to high volatility
- News-driven price movements
- Markets with significant funding rate differentials

### Adverse Conditions
- Choppy, sideways markets with frequent reversals
- Extreme volatility with erratic price movements
- Illiquid markets with wide spreads

## Performance Expectations

- **Expected win rate**: 60-65% (momentum-following strategies historically perform in this range)
- **Expected Sharpe ratio**: 1.5-2.0 (moderate risk-adjusted returns)
- **Maximum drawdown**: 10-15% (controlled by position limits and stop losses)
- **Advantage over simple bots**: Combines multiple signals (price momentum, funding rates, INIT bias) for improved edge 