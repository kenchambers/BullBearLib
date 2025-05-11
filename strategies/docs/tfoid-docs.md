# Trend-Following OI Divergence (TFOID) Strategy Documentation

## Strategy Name & Concept
Trend-Following OI Divergence (TFOID) - Identifies trend continuation setups by analyzing open interest divergences between longs and shorts alongside price momentum.

## Key Insight
The strategy leverages predictive power of open interest imbalances as leading indicators for price movement. When open interest (OI) shows increasing bias in the opposite direction of the current price trend, it often signals an impending squeeze that accelerates the existing trend.

## Technical Indicators
1. **Price Trend** - Identifies direction and strength over configured time periods
2. **Open Interest Ratio** - Tracks long/short OI imbalance
3. **OI Divergence Change** - Measures how rapidly OI bias is shifting
4. **Combined Strength Score** - Weighs divergence magnitude against price momentum

## Position Logic

### Entry Triggers
- **Long Entry**: Uptrend (>5% price increase) + High & increasing short bias in OI
- **Short Entry**: Downtrend (>5% price decrease) + High & increasing long bias in OI

These setups target scenarios where traders are increasingly positioned against the trend, setting up potential liquidation cascades in the trend direction.

### Sizing Formula
- Fixed collateral amount of 10 USDC
- Equal 50/50 split between two paired assets
- Opportunities ranked by strength score (divergence × price momentum)

### Leverage / Risk Limits
- Fixed 3× leverage
- Maximum 2 concurrent positions
- 15% minimum OI divergence threshold

### Exit Criteria
- **Take Profit**: 15% position profit
- **Stop Loss**: 10% position loss
- **Signal Reversal**: OI divergence flips by ≥10%
- **Maximum Hold Time**: 48 hours

## Ideal Market Conditions
TFOID performs best in trending markets with significant trader sentiment opposed to the trend. Optimal during:
- Strong directional trends with high conviction
- Markets with active derivative trading
- Assets with sufficient OI to generate meaningful signals

## Adverse Market Conditions
The strategy may underperform in:
- Choppy, non-trending markets
- Low liquidity markets with minimal OI
- Extreme volatility events that break trend patterns
- Markets with coordinated positioning (where OI doesn't show clear bias)

## Back-test Hypothesis
- **Expected Win Rate**: 55-60%
- **Expected Sharpe Ratio**: 1.2-1.5
- **Maximum Drawdown**: 20-25%
- **Monthly Return Target**: 5-8%

The strategy aims to capitalize on momentum continuation patterns while using OI divergence as a confirmation filter to reduce false signals.

## Why It Beats Simpler Bots
TFOID offers significant advantages over simpler strategies:

1. **Predictive vs. Reactive** - While simple trend followers react to price changes after they occur, TFOID anticipates potential accelerations by detecting positioning imbalances.

2. **Multi-Factor Confirmation** - Combines price action with OI positioning data for higher conviction signals, reducing false entries.

3. **Smart Pairing** - Dynamically selects complementary assets with opposite characteristics, creating natural hedging and optimal risk distribution.

4. **Signal-Based Exits** - Unlike time-based or static exit strategies, TFOID can exit positions when the underlying signal changes, preserving capital during trend shifts.

5. **Adaptive to Market Dynamics** - By tracking OI changes over time rather than static thresholds, the strategy remains effective across different market regimes and volatility environments.

## Usage Instructions
1. Run directly: `node tfoid-strategy.js`
2. Run with continuous execution: `./run-tfoid.sh` (default 30-min interval)
3. Custom interval: `INTERVAL=900 ./run-tfoid.sh` (15-min interval)

## Configuration
Adjust the CONFIG object in `tfoid-strategy.js` to modify:
- Collateral amount and leverage
- Entry and exit thresholds
- Maximum positions and hold times
- Risk parameters 