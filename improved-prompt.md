
# BullBear.zone – Perps-Bot Challenge 

You already have a fully-working SDK for BullBear.zone (Neutron).  
The heavy lifting—wallet loading, RPC, price & funding queries, position opens/closes—is wrapped in @lib.js   

A funded test-wallet mnemonic lives in @.env (`SEED`) with enough USDC.

Your mission: invent and ship a production-ready trading bot that runs on-chain from this repo.

------------------------------------------------------  Reference Material
------------------------------------------------------
@bullBear.md …… platform mechanics, leverage, funding, cluster@lib.js  ………… one-liners for `getMarkets()`, `getFundingRates()`, `openPosition()`, `closePosition()`, etc.  
• @rmm-strategy.js and @tfoid-strategy.js  … complete bot examples (state files, retries, exits).

--------------------------------------------------------------------
🚧  Implementation Rules
--------------------------------------------------------------------
1. Collateral per trade **> $10 USDC** (Use 10.1 to cover gas, can be defined as `CONFIG.COLLATERAL` or similar).  
2. Asset payload must be:

   ```js
   [
     { denom: "perps/ubtc", long: true,  percent: "0.5" },
     { denom: "perps/ueth", long: false, percent: "0.5" }
   ]     // percent *strings* that sum to "1.0"
   ```
Note: traded pairs can also use usdc for a single-asset leveraged long/short

3. ALWAYS call `getMarkets()` first and trade **only enabled** denoms.  
4. Handle RPC quirks:  
   • wrap `execute()` in `try/catch`;  
   • on `"account sequence mismatch"` refresh th@funding-skew-reversal.js ).  
5. Persist bot state under `cache/` so repeated runs  
   • don’t double-enter,  
   • can track IDs for clean exits.  
6. Exit logic is mandatory (time, PnL, funding-reversion—your choice unless specified by the user).  
7. NPM script is optional—running with plain `node strategy.js` is fine.  
   • If you prefer convenience, add `"my-bot": "node my-bot.js"` to **`package.json`**.  
8. Provide a simple runner (e.g. `run-my-bot.sh`) that keeps the strategy looping on a set interval—30 min by default, overridable via `INTERVAL=<seconds>`.
9. Include profuse logging for each step of the strategy's execution, also visible from the runner .sh logs 

--------------------------------------------------------------------
📝  Submission Format
--------------------------------------------------------------------
Reply with these sections **in order**:

1. **Strategy Name & Concept** – one-liner.  
2. **Key Insight** – the unique (AI-flavoured) edge.  
3. **Technical Indicators** – on-chain metrics, off-chain feeds, etc.  
4. **Position Logic**  
   • entry triggers  
   • sizing formula  
   • leverage / risk limits  
   • exit criteria & check frequency  
5. **Ideal / Adverse Market Conditions**  
6. **Implementation Code**  
   • complete `.js` file (strategy)  
   • error handling, retries, state persistence  
   • `run-*.sh` loop script  
7. **Back-test Hypothesis** – expected win-rate, Sharpe, max DD.  
8. **Why It Beats Simpler Bots** – articulate the edge.

Include an updated **`package.json`** **only** if you add new npm deps.

--------------------------------------------------------------------
🏁  Workflow
--------------------------------------------------------------------
1. Propose **3–5 strategy ideas**.  
2. We’ll pick one.  
3. Deliver:  
   • the strategy `.js` file,  
   • a looping shell/cron helper,  
   • a concise docs file.  
4. Run locally with:

   ```bash
   npm install
   # Either via npm script …
   npm run my-bot

   # … or directly
   node my-bot.js

   # Continuous loop (example helper)
   chmod +x run-my-bot.sh
   ./run-my-bot.sh              # default 30-min cadence
   INTERVAL=900 ./run-my-bot.sh # custom 15-min cadence
   ```

Be bold but realistic—creative edges that can actually execute on-chain trump theoretical perfection.