# Volatility Breakout Hunter (VBH) Strategy

## Strategy Overview

The Volatility Breakout Hunter is a specialized trading algorithm designed to capitalize on significant price movements that occur during periods of increased market volatility. It targets assets that are breaking out of established price ranges with heightened volatility, taking directional positions to capture the momentum of these breakout moves.

## Key Features

- **Volatility Detection**: Monitors assets for abnormal increases in price volatility compared to their historical baselines
- **Breakout Confirmation**: Requires multiple confirmatory price samples to validate genuine breakouts from noise
- **Dynamic Leverage**: Adjusts position leverage inversely to volatility (lower leverage during extreme volatility)
- **Trailing Stop Management**: Implements progressive profit-locking exits that move with favorable price action
- **Risk Mitigation**: Employs strict position sizing and fixed stop-loss protection

## Technical Implementation

### Entry Conditions
To qualify for a trading opportunity, an asset must meet ALL of the following criteria:

1. **Minimum Volatility**: Current volatility must exceed threshold (3% by default)
2. **Volatility Spike**: Current volatility must be significantly higher than recent average (1.5x by default)
3. **Price Breakout**: Price must break above recent high (for longs) or below recent low (for shorts)
4. **Breakout Magnitude**: Breakout must exceed minimum size threshold (2% by default)
5. **Confirmation**: Multiple consecutive price samples must confirm the breakout direction

### Position Management

- **Leverage**: Base leverage of 2x, inversely adjusted based on volatility level
- **Position Size**: Fixed collateral amount (10.1 USDC) with dynamic leverage
- **Maximum Risk**: No more than 3 concurrent positions, with only 1 position per asset

### Exit Strategy

The strategy employs a multi-layered exit system:

1. **Fixed Stop Loss**: Exit if position loses 5% of collateral value
2. **Trailing Stop**: Once position reaches 6% profit, implement trailing stop at 4% below maximum profit achieved
3. **Time-Based Exit**: Automatically close position after 48 hours (configurable)

## Configuration Options

The strategy provides multiple configuration parameters that can be adjusted:

```js
const CONFIG = {
  // Trade parameters
  COLLATERAL: 10.1,          // USDC per trade
  BASE_LEVERAGE: 2.0,        // Base leverage level
  MAX_LEVERAGE: 3.0,         // Maximum allowed leverage
  MAX_POSITIONS: 3,          // Maximum concurrent positions
  
  // Volatility settings
  VOLATILITY_WINDOW: 24,     // Data points for volatility calculation
  MIN_VOLATILITY_THRESHOLD: 0.03,  // Minimum volatility required (3%)
  VOLATILITY_BREAKOUT_FACTOR: 1.5, // Required volatility increase factor
  
  // Breakout confirmation
  BREAKOUT_THRESHOLD: 0.02,  // Minimum price movement (2%)
  CONFIRMATION_CANDLES: 2,   // Required consecutive confirmations
  
  // Exit management
  TRAILING_STOP_INITIAL: 0.04, // Initial trailing stop distance (4%)
  PROFIT_LOCK_THRESHOLD: 0.06, // When to activate trailing stop (6%)
  STOP_LOSS_PERCENT: 0.05,   // Fixed stop loss level (5%)
  MAX_POSITION_HOURS: 48,    // Maximum position duration
}
```

## Usage

To run the Volatility Breakout Hunter strategy:

1. **Single Execution**:
   ```bash
   npm run vbh
   ```

2. **Continuous Loop** (default 30-minute interval):
   ```bash
   ./run-vbh.sh
   ```

3. **Custom Interval** (e.g., 15 minutes):
   ```bash
   INTERVAL=900 ./run-vbh.sh
   ```

## Market Conditions

The Volatility Breakout Hunter strategy performs optimally in the following conditions:

### Favorable Conditions
- Market regime changes or transitions
- News-driven volatility spikes
- Range breakouts after consolidation periods
- Trending markets with momentum continuation

### Challenging Conditions
- Choppy, sideways markets with false breakouts
- Low volatility, rangebound environments
- Markets with extreme mean reversion characteristics

## Performance Metrics

Performance monitoring is available through state and history files stored in the `cache/` directory:

- `vbh-state.json`: Current positions and market data
- `vbh-history.json`: Historical trade records with entry/exit metrics

## Data Collection

The strategy collects and processes the following data:

- **Price Data**: Regular price samples at configured intervals
- **Volatility Metrics**: Historical and current volatility measurements
- **Breakout Information**: Direction, strength, and confirmation status
- **Position Management**: Entry prices, max profit levels, and trailing stop values

## Risk Management

The VBH strategy incorporates multiple risk management features:

1. **Position Limits**: Max of 3 concurrent positions
2. **Asset Diversification**: Max of 1 position per asset
3. **Stop-Loss Protection**: Fixed 5% stop loss on all positions
4. **Profit Locking**: Trailing stops to secure profits
5. **Volatility-Adjusted Leverage**: Reduces leverage during extremely volatile conditions
6. **Maximum Hold Time**: Time-based position closure to limit exposure

## Implementation Notes

- The strategy requires several price samples before it can generate reliable signals
- Initial volatility calculations need historical data to establish baselines
- Full effectiveness is achieved after collecting sufficient price history (24+ samples) 