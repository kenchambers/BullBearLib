# Funding-Skew Reversal (FSR) Strategy

## Strategy Overview

The Funding-Skew Reversal (FSR) strategy identifies and exploits divergences between funding rates and price action in perpetual futures markets. This strategy detects when funding rates and price movements become statistically misaligned, signaling potential market inefficiencies that often precede price reversals.

## Core Insight

Funding rates in perpetual futures markets serve as a mechanism to maintain price parity with spot markets and reflect market sentiment. When funding rates become significantly skewed relative to price action (compared to their historical relationship), this often signals an imbalance in market positioning that tends to revert. By measuring this statistical divergence and taking positions accordingly, the FSR strategy exploits these temporary imbalances.

## Technical Indicators

1. **Funding Rate Analysis**: Tracks historical and current funding rates across all available markets
2. **Price-Funding Correlation**: Establishes baseline relationships between price changes and funding rates for each asset
3. **Statistical Skew Detection**: Calculates z-scores to identify deviations from expected correlations
4. **Long/Short Imbalance**: Monitors the ratio of long and short open interest

## Position Logic

### Entry Criteria
- Funding rate must exceed minimum threshold (default: 15% annualized)
- Deviation from historical funding-price correlation must exceed significance threshold (default: 2 standard deviations)
- Asset must not be on cooldown blacklist from recent trades
- Direction is determined by the nature of the skew:
  - When z-score is positive and funding is positive → SHORT
  - When z-score is positive and funding is negative → LONG
  - When z-score is negative and funding is positive → LONG
  - When z-score is negative and funding is negative → SHORT

### Position Sizing
- Uses fixed collateral amount (10.1 USDC per trade)
- Conservative leverage (2.5x)
- Positions split 50/50 between primary asset and complementary asset
- Up to 3 concurrent positions

### Risk Management
- Take profit: 8% profit target
- Stop loss: 5% loss limit
- Maximum hold time: 72 hours

### Exit Criteria
- Take profit or stop loss hit
- Maximum hold time reached
- Funding rate crosses zero (sign change)
- Funding rate magnitude decreases by 70% or more
- Funding skew direction reverses

## Market Conditions

### Ideal Market Conditions
- High volatility markets with active sentiment shifts
- Assets with large long/short imbalances in open interest
- Divergent funding across different assets (allowing for complementary pairs)
- Assets with historically stable funding-price relationships that suddenly deviate

### Adverse Market Conditions
- Low volatility, range-bound markets with minimal funding rates
- Assets with weak historical correlation patterns
- Markets in strong directional trends where fundamental factors override positioning imbalances
- Low liquidity markets where funding rates are less meaningful

## Implementation Details

The FSR strategy is implemented with robust state management and error handling:

- **State Persistence**: Tracks positions, price history, funding history, and correlation metrics
- **Statistical Analysis**: Dynamic calculation of asset-specific correlation metrics
- **Position Management**: Comprehensive entry and exit logic
- **Risk Controls**: Blacklisting recently traded assets to prevent over-trading
- **Error Handling**: Retries on blockchain errors, especially sequence mismatches

## Running the Strategy

1. Ensure environment is set up with proper `.env` file containing `SEED` mnemonic
2. Run the strategy once:
   ```
   node strategies/funding-skew-reversal.js
   ```
3. Run continuously with default 30-minute interval:
   ```
   ./run-fsr.sh
   ```
4. Run with custom interval (e.g., 15 minutes):
   ```
   INTERVAL=900 ./run-fsr.sh
   ```

## Expected Performance

### Theoretical Edge
The FSR strategy capitalizes on the tendency of market positioning to become temporarily imbalanced, creating funding rate anomalies that often precede price corrections. By detecting statistical anomalies in the relationship between funding rates and price movements, the strategy aims to predict short-term market direction with higher accuracy than random.

### Expected Metrics
- **Win Rate**: Estimated 55-60% (theoretical)
- **Risk-Reward Ratio**: 1.6:1 (8% take profit vs. 5% stop loss)
- **Maximum Drawdown**: Estimated 15-20% 
- **Expected Monthly Return**: 5-15% (highly market dependent)

## Advantages Over Simpler Approaches

1. **Statistical Edge**: Uses rigorous statistical methods rather than simple thresholds
2. **Asset-Specific Calibration**: Dynamically calculates correlation metrics for each asset
3. **Adaptive Positioning**: Considers both absolute funding rates and deviations from expected relationships
4. **Complementary Pairing**: Intelligently pairs assets to maximize edge when possible
5. **Multi-Factor Exit**: Combines time-based, profit-based and signal-reversal exits
6. **State Persistence**: Maintains cross-run memory for consistent long-term execution 