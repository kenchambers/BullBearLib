# Rapid Market Momentum (RMM) Strategy Documentation

## Strategy Name & Concept
Rapid Market Momentum (RMM) - A demo-focused strategy that executes high-frequency trades with minimal barriers to entry, designed for immediate trading execution and demonstration purposes.

## Key Insight
Traditional trading strategies often require significant time to build up price history and identify complex patterns before executing trades. RMM is specifically designed to start trading immediately with minimal data requirements, making it ideal for demonstrations, testing, and rapid deployment. It uses minimal price movement thresholds and can even force trades when necessary for demonstration purposes.

## Technical Indicators
1. **Short-Term Price Change** - Identifies very recent price movements (as small as 0.25%)
2. **Funding Rate Direction** - Used as a fallback signal when price movement is insufficient
3. **Asset Rotation System** - Ensures trading across different assets with a blacklist cycling mechanism
4. **Forced Trade Logic** - Guarantees trading activity even when traditional signals are absent

## Position Logic

### Entry Triggers
- **Primary Signal**: Price movement of just 0.25% in either direction
- **Secondary Signal**: Funding rate direction when price movement is insufficient
- **Fallback**: Random direction selection for guaranteed demo execution
- **Asset Eligibility**: Automatic rotation through available assets every 15 minutes

### Sizing Formula
- Fixed collateral amount of 10 USDC
- Equal 50/50 split between paired assets
- Multiple smaller positions rather than fewer large ones

### Leverage / Risk Limits
- Moderate 2× leverage for demonstration safety
- Maximum 3 concurrent positions
- Maximum 1 position per unique asset

### Exit Criteria
- **Take Profit**: Small 5% profit target for rapid turnover
- **Stop Loss**: Tight 3% stop loss for demonstration
- **Maximum Hold Time**: 12 hours (though typically positions turn over much faster)
- **Automatic Rotation**: Asset blacklisting prevents immediate re-entry after exit

## Ideal Market Conditions
RMM is designed to operate in any market conditions, but performs best in:
- Markets with any degree of volatility (even very low volatility)
- Markets with frequent small price movements
- Environments where quick demonstration of trading activity is required
- Testing environments for UI/UX validation

## Adverse Market Conditions
The strategy deliberately has minimal sensitivity to market conditions, but may still face challenges in:
- Exchange downtime or API connectivity issues
- Extreme market stress with circuit breakers or trading halts
- Unprecedented market conditions where even minimal price movements are absent

## Back-test Hypothesis
As a demo-focused strategy, RMM prioritizes activity over profitability. However, its expected metrics are:
- **Expected Win Rate**: ~50% (similar to random in certain conditions)
- **Expected Sharpe Ratio**: 0.5-0.8 (lower than investment-grade strategies)
- **Maximum Drawdown**: 10-15% (limited by tight stop losses)
- **Trading Frequency**: Very high - multiple trades per day depending on market

The strategy is designed primarily for demonstration of the trading infrastructure rather than alpha generation.

## Why It's Perfect for Demos
RMM offers significant advantages as a demonstration strategy:

1. **Immediate Execution** - Begins trading as soon as it's deployed with minimal data requirements.

2. **High Visibility** - Creates frequent trading activity that's ideal for demonstrating platform functionality.

3. **Rotation Mechanism** - Automatically cycles through different assets to showcase variety in trading.

4. **Fallback Systems** - The FORCE_TRADE option ensures trading activity even when signals are weak, perfect for demos.

5. **Self-Clearing** - The blacklist mechanism prevents overwhelming the system with too many positions.

6. **Demonstration-Friendly Settings** - Tight stop-losses and take-profits ensure rapid position turnover.

7. **Configurable Aggressiveness** - Easily adjusted thresholds to make the strategy more or less active.

## Usage Instructions
1. Run directly: `node rmm-strategy.js`
2. Run with continuous execution: `./run-rmm.sh` (default 5-min interval)
3. Custom interval: `INTERVAL=60 ./run-rmm.sh` (1-min interval for maximum activity)

## Configuration
Adjust the CONFIG object in `rmm-strategy.js` to modify:
- MIN_PRICE_CHANGE - Lower for more frequent trading
- FORCE_TRADE - Set to true to guarantee trading activity
- ROTATION_DELAY_MINUTES - Adjust how quickly assets rotate
- TAKE_PROFIT_PERCENT and STOP_LOSS_PERCENT - Adjust trade durations
- MAX_POSITIONS - Control how many concurrent trades are allowed 