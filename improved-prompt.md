# BullBear.zone – Perps-Bot Challenge 

You already have a fully-working SDK for BullBear.zone (Neutron).  
The heavy lifting—wallet loading, RPC, price & funding queries, position opens/closes—is wrapped in `lib.js`   

A funded test-wallet mnemonic lives in `.env` (`SEED`) with enough USDC.

Your mission: invent and ship a production-ready trading bot that runs on-chain from this repo.

------------------------------------------------------  Reference Material
------------------------------------------------------
- `bullBear.md` - platform mechanics, leverage, funding, clusters
- `lib.js` - core functions for `getMarkets()`, `getFundingRates()`, `openPosition()`, `closePosition()`, etc.
- `run.js` - basic example showing how to fetch data and create positions
- `strategies/` - directory for implemented trading strategies
- `runners/` - directory for shell scripts that run the strategies on intervals
- Look at existing strategies for examples of proper state management and error handling

--------------------------------------------------------------------
🚧  Implementation Rules
--------------------------------------------------------------------
1. **Directory Structure**:
   - Place your strategy file in the `strategies/` directory
   - Place your runner script in the `runners/` directory
   - Use `consts.js` for access to `CACHE_DIR` and other constants

2. **Collateral Requirements**:
   - Use **10.1 USDC** per trade (slightly above $10 min to cover gas fees)
   - Define as `CONFIG.COLLATERAL` in your strategy

3. **Position Structure**:
   - Single-asset positions (recommended for simplicity):
     ```js
     [
       { denom: "perps/ubtc", long: true, percent: "1.0" }
     ]
     ```
   - Multi-asset positions (if needed):
     ```js
     [
       { denom: "perps/ubtc", long: true, percent: "0.5" },
       { denom: "perps/ueth", long: false, percent: "0.5" }
     ]
     ```
   - Ensure percents are strings and sum to "1.0"

4. **Leverage Management**:
   - Use `getMaxLeverages()` to respect protocol-defined limits for each asset
   - Implement conservative default leverage (2-3x recommended)
   - Consider reducing leverage for volatile assets

5. **Error Handling Requirements**:
   - Add delays between consecutive position openings (20+ seconds) 
   - Handle "account sequence mismatch" errors with retries
   - Implement proper blacklisting for assets that cause contract errors
   - Always check `result` from position operations for null/errors

6. **State Management**:
   - Persist state in `CACHE_DIR` (from `consts.js`) to track positions across runs
   - Clean up stale positions that don't exist on-chain anymore
   - Implement blacklisting mechanism for problematic assets
   - Consider time intervals and price changes when collecting market data

7. **Exit Logic (Mandatory)**:
   - Implement profit targets (take profit)
   - Implement stop losses to control downside
   - Add maximum hold time limits
   - Consider funding rate normalization for funding-based strategies

8. **Comprehensive Logging**:
   - Use `chalk` for color-coded, readable logs
   - Log each step of the strategy execution
   - Include detailed error reporting
   - Show metrics (funding rates, price changes, PnL) with proper formatting

--------------------------------------------------------------------
📝  Submission Format
--------------------------------------------------------------------
Reply with these sections **in order**:

1. **Strategy Name & Concept** – one-liner.  
2. **Key Insight** – the unique edge your strategy exploits.
3. **Technical Indicators** – on-chain metrics, off-chain feeds, etc.  
4. **Position Logic**:
   • entry triggers  
   • sizing formula  
   • leverage approach (fixed vs. dynamic)
   • exit criteria & check frequency  
5. **Ideal & Adverse Market Conditions**
6. **Implementation Code**:
   • Strategy file (`strategies/your-strategy.js`)
   • Runner script (`runners/run-your-strategy.sh`)
   • Documentation file (`strategies/your-strategy-docs.md`)
7. **Back-test Hypothesis** – expected win-rate, Sharpe, max drawdown.
8. **Why It Beats Simpler Bots** – articulate the edge.

Include an updated **`package.json`** **only** if you add new npm deps.

--------------------------------------------------------------------
🏁  Workflow
--------------------------------------------------------------------
1. Propose **3–5 strategy ideas**.  
2. We'll pick one.  
3. Deliver:  
   • Strategy file in `strategies/your-strategy.js`
   • Runner script in `runners/run-your-strategy.sh`
   • Documentation in `strategies/your-strategy-docs.md`
4. Run locally with:

   ```bash
   npm install
   
   # Run the strategy once
   node strategies/your-strategy.js
   
   # Run continuously with the runner script
   cd runners
   chmod +x run-your-strategy.sh
   ./run-your-strategy.sh              # default 30-min interval
   INTERVAL=900 ./run-your-strategy.sh # custom 15-min interval
   ```

Be bold but realistic—creative edges that can actually execute on-chain trump theoretical perfection. Pay special attention to robust error handling, state persistence, and preventing transaction failures.

--------------------------------------------------------------------
📊  Example Strategy Types
--------------------------------------------------------------------
1. **Funding Rate Arbitrage**: Capture funding payments by going long negative funding assets and short positive funding assets
2. **Volatility Breakout**: Detect and trade significant price moves when assets break out of recent ranges
3. **Mean Reversion**: Identify overbought/oversold conditions and trade the reversion to the mean
4. **Momentum Following**: Track and trade with the direction of established momentum
5. **Correlation Arbitrage**: Exploit temporary deviations in correlated assets

Each has strengths and weaknesses in different market conditions. Your creativity in combining elements or finding unique edges is encouraged.