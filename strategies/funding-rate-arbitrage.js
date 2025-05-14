require("dotenv").config();
const chalk = require("chalk");
const fs = require("fs");
const path = require("path");

// Core trade helpers
const {
  getClient,
  getPositions,
  openPosition,
  closePosition,
  getBalance,
  getMarkets,
  getPrices,
  getFundingRates,
  getMaxLeverages,
} = require("../lib");
const { CACHE_DIR } = require("../consts");

/*
  -------------------------------------------------------
  Funding Rate Arbitrage (FRA) Strategy
  -------------------------------------------------------
  Core concept:
    • Captures assets with extreme funding rates
    • Goes long on negative funding (shorts pay longs)
    • Goes short on positive funding (longs pay shorts)
    • Uses single-asset positions to maximize funding yield
    • Exits when funding rates normalize or upon take profit/stop loss
*/

// ---------- CONFIGURATION ----------
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
  STATE_FILE: path.join(CACHE_DIR, "fra-state.json"),
  HISTORY_FILE: path.join(CACHE_DIR, "fra-history.json"),
  BLACKLIST_HOURS: 6, // Hours to blacklist an asset after closing
  DRY_RUN: false, // Set to true to simulate without trading
  DEBUG: true, // Show extra debug info
};

// ---------- STATE MANAGEMENT ----------
function initializeCache() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function loadState() {
  initializeCache();
  try {
    if (fs.existsSync(CONFIG.STATE_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG.STATE_FILE, "utf8"));
    }
  } catch (err) {
    console.error(chalk.red("Error loading state:", err.message));
  }
  return { 
    positions: {},  // { positionId: { createdAt, assets, entryPrices, entryFundingRates } }
    assetBlacklist: {}, // { denom: expirationTimestamp }
    lastRun: null // Timestamp of last full run
  };
}

function saveState(state) {
  try {
    // Helper function to make objects JSON-serializable
    function makeSerializable(obj) {
      return JSON.parse(JSON.stringify(obj, (key, value) => 
        typeof value === 'bigint' ? value.toString() : value
      ));
    }
    
    fs.writeFileSync(CONFIG.STATE_FILE, JSON.stringify(makeSerializable(state), null, 2));
  } catch (err) {
    console.error(chalk.red("Error saving state:", err.message));
  }
}

function recordTrade(position, action, result, metrics = {}) {
  try {
    // Helper function to make objects JSON-serializable
    function makeSerializable(obj) {
      return JSON.parse(JSON.stringify(obj, (key, value) => 
        typeof value === 'bigint' ? value.toString() : value
      ));
    }
    
    let history = [];
    if (fs.existsSync(CONFIG.HISTORY_FILE)) {
      history = JSON.parse(fs.readFileSync(CONFIG.HISTORY_FILE, "utf8"));
    }
    
    // Ensure all data is serializable
    const serializablePosition = makeSerializable(position);
    const serializableResult = makeSerializable(result);
    const serializableMetrics = makeSerializable(metrics);
    
    history.push({
      timestamp: Date.now(),
      action, // "open" or "close"
      position: serializablePosition,
      metrics: serializableMetrics, // Additional metrics like funding rates, OI imbalance, etc.
      result: serializableResult || null,
    });
    
    fs.writeFileSync(CONFIG.HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (err) {
    console.error(chalk.red("Error recording trade:", err.message));
  }
}

// ---------- ANALYSIS FUNCTIONS ----------
function findFundingRateOpportunities(enabledMarkets, fundingRates, state, maxLeverages) {
  const opportunities = [];
  const now = Date.now();
  
  if (CONFIG.DEBUG) {
    console.log(chalk.blue(`Analyzing ${enabledMarkets.length} markets for funding rate opportunities`));
  }
  
  for (const market of enabledMarkets) {
    const denom = market.denom;
    
    // Skip blacklisted assets
    if (state.assetBlacklist[denom] && state.assetBlacklist[denom] > now) {
      if (CONFIG.DEBUG) {
        console.log(chalk.gray(`Skipping ${denom}: blacklisted until ${new Date(state.assetBlacklist[denom]).toLocaleString()}`));
      }
      continue;
    }
    
    // Skip if we don't have funding data
    if (!fundingRates[denom]) {
      if (CONFIG.DEBUG) {
        console.log(chalk.gray(`Skipping ${denom}: no funding data available`));
      }
      continue;
    }
    
    const fundingRate = fundingRates[denom].fundingRate;
    const longOI = parseFloat(fundingRates[denom].longOI || 0);
    const shortOI = parseFloat(fundingRates[denom].shortOI || 0);
    
    // Skip if funding rate is too small
    if (Math.abs(fundingRate) < CONFIG.MIN_FUNDING_RATE_ENTRY) {
      if (CONFIG.DEBUG) {
        console.log(chalk.gray(`Skipping ${denom}: funding rate ${fundingRate.toFixed(2)}% below threshold ${CONFIG.MIN_FUNDING_RATE_ENTRY}%`));
      }
      continue;
    }
    
    // Calculate OI imbalance
    let oiImbalance = 1.0;
    let oiDirection = null;
    
    if (longOI > 0 && shortOI > 0) {
      if (longOI > shortOI) {
        oiImbalance = longOI / shortOI;
        oiDirection = "long";
      } else {
        oiImbalance = shortOI / longOI;
        oiDirection = "short";
      }
    }
    
    // Skip if OI imbalance is too low
    if (oiImbalance < CONFIG.MIN_OI_IMBALANCE) {
      if (CONFIG.DEBUG) {
        console.log(chalk.gray(`Skipping ${denom}: OI imbalance ${oiImbalance.toFixed(2)} below threshold ${CONFIG.MIN_OI_IMBALANCE}`));
      }
      continue;
    }
    
    // Determine position direction
    const direction = fundingRate < 0 ? "long" : "short";
    
    // Calculate opportunity strength metric
    // Higher absolute funding rate and higher OI imbalance = stronger opportunity
    const strength = Math.abs(fundingRate) * oiImbalance;
    
    opportunities.push({
      denom,
      fundingRate,
      direction,
      oiImbalance,
      oiDirection,
      longOI,
      shortOI,
      score: strength,
      maxLeverage: maxLeverages[denom] || CONFIG.LEVERAGE
    });
    
    if (CONFIG.DEBUG) {
      console.log(chalk.green(`Found opportunity: ${denom} (${direction.toUpperCase()})`));
      console.log(chalk.green(`  Funding Rate: ${fundingRate.toFixed(2)}%, OI Imbalance: ${oiImbalance.toFixed(2)}x (${oiDirection || 'N/A'})`));
      console.log(chalk.green(`  Long OI: ${longOI}, Short OI: ${shortOI}`));
      console.log(chalk.green(`  Max Leverage: ${maxLeverages[denom] || 'default'}x`));
    }
  }
  
  // Sort by strength (highest first)
  return opportunities.sort((a, b) => b.score - a.score);
}

// ---------- POSITION MANAGEMENT ----------
async function checkExitConditions(position, state, fundingRates) {
  const positionId = position.id;
  const positionState = state.positions[positionId];
  
  if (!positionState) return { shouldExit: false };
  
  // 1. Check max hold time
  const holdTimeHours = (Date.now() - positionState.createdAt) / (1000 * 60 * 60);
  if (holdTimeHours > CONFIG.MAX_POSITION_HOURS) {
    console.log(chalk.yellow(`Position ${positionId} reached max hold time (${holdTimeHours.toFixed(1)} hours)`));
    return { shouldExit: true, reason: "max_hold_time" };
  }
  
  // 2. Check for take profit or stop loss
  let totalPnlPercent = 0;
  
  for (const asset of position.assets) {
    // Get current price from current position data
    const currentPrice = parseFloat(position.exec_price || position.assets[0].exec_price || 0);
    const entryPrice = parseFloat(positionState.entryPrices[asset.denom] || 0);
    
    if (!entryPrice || entryPrice === 0 || !currentPrice || currentPrice === 0) continue;
    
    // Calculate price change
    const priceChange = (currentPrice - entryPrice) / entryPrice;
    const assetPnlPercent = asset.long ? priceChange : -priceChange;
    
    // Weight by position percentage
    const weight = parseFloat(asset.percent);
    totalPnlPercent += assetPnlPercent * weight;
  }
  
  // Take profit check
  if (totalPnlPercent >= CONFIG.TAKE_PROFIT_PERCENT) {
    console.log(chalk.green(`Position ${positionId} reached take profit target: ${(totalPnlPercent * 100).toFixed(2)}%`));
    return { shouldExit: true, reason: "take_profit", pnl: totalPnlPercent };
  }
  
  // Stop loss check
  if (totalPnlPercent <= -CONFIG.STOP_LOSS_PERCENT) {
    console.log(chalk.red(`Position ${positionId} hit stop loss: ${(totalPnlPercent * 100).toFixed(2)}%`));
    return { shouldExit: true, reason: "stop_loss", pnl: totalPnlPercent };
  }
  
  // 3. Check if funding rate has normalized
  for (const asset of position.assets) {
    const denom = asset.denom;
    
    // Skip non-perp assets (like USDC)
    if (!denom.startsWith('perps/')) continue;
    
    // Skip if no current funding data
    if (!fundingRates[denom]) continue;
    
    const currentFundingRate = fundingRates[denom].fundingRate;
    const entryFundingRate = positionState.entryFundingRates[denom];
    
    // Skip if we don't have entry funding rate
    if (!entryFundingRate) continue;
    
    // Check if funding rate has normalized (dropped below exit threshold)
    if (Math.abs(currentFundingRate) < CONFIG.MIN_FUNDING_RATE_EXIT) {
      console.log(chalk.yellow(`Position ${positionId} funding rate has normalized`));
      console.log(chalk.yellow(`  Entry funding rate: ${entryFundingRate.toFixed(2)}%, Current: ${currentFundingRate.toFixed(2)}%`));
      return { shouldExit: true, reason: "funding_normalized", pnl: totalPnlPercent };
    }
    
    // Check if funding rate has flipped direction
    if ((entryFundingRate > 0 && currentFundingRate < 0) || (entryFundingRate < 0 && currentFundingRate > 0)) {
      console.log(chalk.yellow(`Position ${positionId} funding rate direction has flipped`));
      console.log(chalk.yellow(`  Entry funding rate: ${entryFundingRate.toFixed(2)}%, Current: ${currentFundingRate.toFixed(2)}%`));
      return { shouldExit: true, reason: "funding_direction_change", pnl: totalPnlPercent };
    }
  }
  
  return { shouldExit: false, pnl: totalPnlPercent };
}

async function openFRAPosition(assets, leverage, attempt = 0) {
  if (CONFIG.DRY_RUN) {
    console.log(chalk.yellow(`[DRY RUN] Would open position with assets: ${JSON.stringify(assets)} at ${leverage}x leverage`));
    return { dryRun: true };
  }
  
  try {
    const result = await openPosition(assets, leverage, CONFIG.COLLATERAL);
    
    // Check if the position opening failed (lib.js returns null on error)
    if (!result) {
      console.error(chalk.red(`Failed to open position for ${assets[0].denom} - contract returned error`));
      // Return error with denom for blacklisting
      return { error: true, denom: assets[0].denom };
    }
    
    console.log(chalk.green(`Position opened successfully with ${leverage}x leverage and ${CONFIG.COLLATERAL} USDC`));
    return result;
  } catch (err) {
    if (err.message && err.message.includes("account sequence mismatch") && attempt < 2) {
      console.log(chalk.yellow("Sequence mismatch detected - refreshing client and retrying..."));
      await new Promise((resolve) => setTimeout(resolve, 10000)); // Wait 10 seconds
      await getClient(); // Refresh client
      return await openFRAPosition(assets, leverage, attempt + 1);
    }
    console.error(chalk.red(`Error opening position: ${err.message}`));
    return { error: true, message: err.message, denom: assets[0].denom };
  }
}

async function closeFRAPosition(positionId, attempt = 0) {
  if (CONFIG.DRY_RUN) {
    console.log(chalk.yellow(`[DRY RUN] Would close position ${positionId}`));
    return { dryRun: true, positionId };
  }
  
  try {
    const result = await closePosition(positionId);
    console.log(chalk.green(`Position ${positionId} closed successfully`));
    return result;
  } catch (err) {
    if (err.message && err.message.includes("account sequence mismatch") && attempt < 2) {
      console.log(chalk.yellow("Sequence mismatch detected - refreshing client and retrying..."));
      await new Promise((resolve) => setTimeout(resolve, 10000)); // Wait 10 seconds
      await getClient(); // Refresh client
      return await closeFRAPosition(positionId, attempt + 1);
    }
    console.error(chalk.red(`Error closing position ${positionId}: ${err.message}`));
    throw err;
  }
}

// ---------- MAIN STRATEGY LOGIC ----------
async function managePositions(state, enabledMarkets, fundingRates, prices, maxLeverages) {
  console.log(chalk.blue("Starting position management..."));
  
  // 1. Get current open positions
  const openPositions = await getPositions();
  console.log(chalk.blue(`Found ${openPositions.length} open positions, ${Object.keys(state.positions).length} tracked by FRA strategy`));
  
  // 2. Check for positions to exit
  for (const position of openPositions) {
    const positionId = position.id;
    
    // Skip positions not managed by this strategy
    if (!state.positions[positionId]) {
      if (CONFIG.DEBUG) {
        console.log(chalk.gray(`Position ${positionId} not managed by FRA strategy, skipping`));
      }
      continue;
    }
    
    // Check if we should exit this position
    const exitCheck = await checkExitConditions(position, state, fundingRates);
    if (exitCheck.shouldExit) {
      try {
        console.log(chalk.yellow(`Closing position ${positionId} - Reason: ${exitCheck.reason}, PnL: ${exitCheck.pnl ? (exitCheck.pnl * 100).toFixed(2) + '%' : 'unknown'}`));
        const result = await closeFRAPosition(positionId);
        
        // Record the closed trade
        recordTrade(position, "close", result, {
          reason: exitCheck.reason,
          pnl: exitCheck.pnl,
          holdTimeHours: (Date.now() - state.positions[positionId].createdAt) / (1000 * 60 * 60)
        });
        
        // Add assets to blacklist
        const blacklistExpiration = Date.now() + (CONFIG.BLACKLIST_HOURS * 60 * 60 * 1000);
        for (const asset of position.assets) {
          // Only blacklist perps assets, not USDC
          if (asset.denom.startsWith('perps/')) {
            state.assetBlacklist[asset.denom] = blacklistExpiration;
            console.log(chalk.blue(`Blacklisted ${asset.denom} until ${new Date(blacklistExpiration).toLocaleString()}`));
          }
        }
        
        // Remove from state
        delete state.positions[positionId];
        saveState(state);
      } catch (error) {
        console.error(chalk.red(`Failed to close position ${positionId}: ${error.message}`));
      }
    } else if (CONFIG.DEBUG) {
      console.log(chalk.gray(`Position ${positionId} - Current PnL: ${(exitCheck.pnl * 100).toFixed(2)}%, holding...`));
    }
  }
  
  // 3. Look for new positions to open (if we're under the max position limit)
  const currentPositionCount = Object.keys(state.positions).length;
  if (currentPositionCount >= CONFIG.MAX_POSITIONS) {
    console.log(chalk.blue(`Already at max positions (${currentPositionCount}/${CONFIG.MAX_POSITIONS}). Not opening new positions.`));
    return;
  }
  
  // 4. Find funding rate opportunities
  const opportunities = findFundingRateOpportunities(enabledMarkets, fundingRates, state, maxLeverages);
  
  if (opportunities.length === 0) {
    console.log(chalk.blue("No funding rate opportunities found that meet criteria."));
    return;
  }
  
  console.log(chalk.blue(`Found ${opportunities.length} potential opportunities.`));
  
  // 5. Open new positions with the best opportunities
  const availableSlots = CONFIG.MAX_POSITIONS - currentPositionCount;
  const opportunitiesToTake = opportunities.slice(0, availableSlots);
  
  console.log(chalk.blue(`Taking top ${opportunitiesToTake.length} opportunities...`));
  
  // Open positions sequentially with delay between them
  for (let i = 0; i < opportunitiesToTake.length; i++) {
    const opportunity = opportunitiesToTake[i];
    
    try {
      // Add a delay between position openings to avoid sequence mismatch errors
      if (i > 0) {
        console.log(chalk.blue(`Waiting 20 seconds before opening next position to avoid sequence errors...`));
        await new Promise(resolve => setTimeout(resolve, 20000));
        
        // Refresh client to get updated sequence number
        await getClient();
      }
      
      // Create assets for the position - use single-asset approach
      const assets = [
        {
          denom: opportunity.denom,
          long: opportunity.direction === "long",
          percent: "1.0" // Single asset position
        }
      ];
      
      console.log(chalk.blue(`Opening position with asset: ${JSON.stringify(assets)}`));
      
      // Determine appropriate leverage - use the lower of target leverage and max allowed
      const targetLeverage = CONFIG.LEVERAGE;
      const maxLeverage = opportunity.maxLeverage?.toString() || CONFIG.LEVERAGE;
      const useLeverage = Math.min(parseInt(targetLeverage), parseInt(maxLeverage)).toString();
      
      console.log(chalk.blue(`Using leverage: ${useLeverage}x (max allowed: ${maxLeverage}x)`));
      
      // Open the position
      const result = await openFRAPosition(assets, useLeverage);
      
      // Check for errors in position opening
      if (result && result.error) {
        console.log(chalk.red(`Failed to open position for ${opportunity.denom}: ${result.message || 'Contract error'}`));
        
        // Blacklist this asset temporarily
        const blacklistExpiration = Date.now() + (CONFIG.BLACKLIST_HOURS * 60 * 60 * 1000);
        state.assetBlacklist[opportunity.denom] = blacklistExpiration;
        console.log(chalk.yellow(`Blacklisted ${opportunity.denom} until ${new Date(blacklistExpiration).toLocaleString()} due to error`));
        
        // Save state
        saveState(state);
        continue; // Skip to next opportunity
      }
      
      // Extract position ID from result
      let positionId = null;
      if (result && result.events) {
        const events = JSON.stringify(result.events);
        const match = events.match(/position_id[\"']?:[\s]*[\"']?(\d+)/);
        if (match) {
          positionId = match[1];
        }
      }
      
      if (positionId || CONFIG.DRY_RUN) {
        // Store entry prices and funding rates
        const entryPrices = {};
        const entryFundingRates = {};
        
        for (const asset of assets) {
          // Store entry price from prices data
          if (prices[asset.denom]) {
            entryPrices[asset.denom] = prices[asset.denom];
          }
          
          // Store entry funding rate
          if (fundingRates[asset.denom]) {
            entryFundingRates[asset.denom] = fundingRates[asset.denom].fundingRate;
          }
        }
        
        // Save to state
        if (CONFIG.DRY_RUN) {
          positionId = `dry-run-${Date.now()}`;
        }
        
        state.positions[positionId] = {
          createdAt: Date.now(),
          assets,
          entryPrices,
          entryFundingRates
        };
        
        saveState(state);
        
        // Record the opened trade
        recordTrade({
          id: positionId,
          assets: assets
        }, "open", result, {
          fundingRate: opportunity.fundingRate,
          oiImbalance: opportunity.oiImbalance,
          oiDirection: opportunity.oiDirection,
          entryPrices,
          entryFundingRates
        });
        
        console.log(chalk.green(`Successfully opened position ${positionId}`));
      } else {
        console.log(chalk.yellow("Position opened but could not determine position ID"));
      }
    } catch (error) {
      console.error(chalk.red(`Failed to open position: ${error.message}`));
    }
  }
}

// ---------- MAIN FUNCTION ----------
async function main() {
  try {
    console.log(chalk.blue("Starting Funding Rate Arbitrage (FRA) Strategy"));
    
    // 1. Initialize client
    const client = await getClient();
    console.log(chalk.green(`Connected to BullBear. Address: ${client.myAddress}`));
    
    // 2. Check USDC balance
    const balance = await getBalance();
    console.log(chalk.green(`USDC Balance: ${balance}`));
    
    if (balance < CONFIG.COLLATERAL) {
      console.error(chalk.red(`Insufficient balance (${balance} USDC). Need at least ${CONFIG.COLLATERAL} USDC.`));
      return;
    }
    
    // 3. Load state
    let state = loadState();
    
    // 4. Get enabled markets
    const enabledMarkets = await getMarkets();
    console.log(chalk.blue(`Found ${enabledMarkets.length} enabled markets`));
    
    // 5. Get max leverages for all markets
    const maxLeverages = await getMaxLeverages();
    console.log(chalk.blue(`Fetched maximum leverage data for ${Object.keys(maxLeverages).length} markets`));
    
    if (CONFIG.DEBUG) {
      // Log a few examples of max leverages
      const examples = Object.entries(maxLeverages).slice(0, 3);
      for (const [denom, maxLev] of examples) {
        console.log(chalk.gray(`Max leverage for ${denom}: ${maxLev}x`));
      }
    }
    
    // 6. Get funding rates and prices
    const fundingRates = await getFundingRates();
    const prices = await getPrices();
    
    // 7. Manage positions
    await managePositions(state, enabledMarkets, fundingRates, prices, maxLeverages);
    
    // 8. Update last run timestamp
    state.lastRun = Date.now();
    saveState(state);
    
    console.log(chalk.green("Funding Rate Arbitrage (FRA) Strategy run completed"));
  } catch (error) {
    console.error(chalk.red(`Fatal error: ${error.message}`));
  }
}

// Run the strategy
if (require.main === module) {
  main().catch(console.error);
}

module.exports = { main };
