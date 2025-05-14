require("dotenv").config();
const fs = require("fs");
const path = require("path");
const chalk = require("chalk");

// Core trade helpers
const {
  getClient,
  getPositions,
  openPosition,
  closePosition,
  getBalance,
  getMarkets,
  getPrices,
  getFundingRates
} = require("../lib");
const { CACHE_DIR } = require("../consts");

/*
  -------------------------------------------------------
  Yield Harvester Strategy
  -------------------------------------------------------
  Core concept:
    • Captures funding rate yield opportunities
    • Goes long on negative funding (shorts pay longs)
    • Goes short on positive funding (longs pay shorts)
    • Exits when funding rates normalize or upon profit target/stop loss
    • Dynamically adjusts leverage based on asset volatility
*/

// Configuration
const CONFIG = {
  // Trading parameters
  COLLATERAL: 10.1, // USDC per position (covers gas costs)
  MIN_FUNDING_ENTRY: 15, // 15% annualized funding rate threshold for entry
  MIN_FUNDING_EXIT: 5, // Exit when funding normalizes below this
  MAX_POSITION_HOLD_HOURS: 72, // Maximum position hold time (3 days)
  PROFIT_TARGET_PCT: 3, // Take profit at 3% gain
  STOP_LOSS_PCT: 2, // Cut losses at 2% drawdown
  MAX_POSITIONS: 3, // Maximum concurrent positions
  
  // Risk management
  LEVERAGE_NORMAL: "2", // Standard leverage 
  LEVERAGE_HIGH_VOL: "1.5", // Reduced leverage during high volatility
  VOLATILITY_THRESHOLD: 5, // 5% 24h change considered high volatility
  
  // Position selection
  MIN_OI_IMBALANCE: 1.3, // Minimum open interest imbalance ratio to consider
  PRIORITIZE_HIGH_LIQUIDITY: true, // Prefer higher liquidity assets

  // Operational settings
  STATE_FILE: path.join(CACHE_DIR, "yield-harvester-state.json"),
  HISTORY_FILE: path.join(CACHE_DIR, "yield-harvester-history.json"),
  DRY_RUN: false, // Set to true to simulate without trading
  DEBUG: true, // Show extra debug info
};

// Initialize state management
function initializeCache() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    console.log(chalk.blue(`📁 Created cache directory: ${CACHE_DIR}`));
  }
}

// Load previous state
function loadState() {
  initializeCache();
  try {
    if (fs.existsSync(CONFIG.STATE_FILE)) {
      const data = fs.readFileSync(CONFIG.STATE_FILE, "utf8");
      const loadedState = JSON.parse(data);
      console.log(chalk.green(`📁 Loaded state with ${Object.keys(loadedState.positions).length} active positions`));
      return loadedState;
    } else {
      console.log(chalk.blue("📁 No previous state found, starting fresh"));
    }
  } catch (error) {
    console.error(chalk.red(`❌ Error loading state: ${error.message}`));
  }
  
  return { 
    positions: {},  // { positionId: { ... position data ... } }
    assetBlacklist: {}, // { denom: expirationTimestamp }
    lastRun: null // Timestamp of last full run
  };
}

// Save current state
function saveState(state) {
  try {
    // Helper function to make objects JSON-serializable
    function makeSerializable(obj) {
      return JSON.parse(JSON.stringify(obj, (key, value) => 
        typeof value === 'bigint' ? value.toString() : value
      ));
    }
    
    fs.writeFileSync(CONFIG.STATE_FILE, JSON.stringify(makeSerializable(state), null, 2));
    console.log(chalk.green(`📝 Saved state with ${Object.keys(state.positions).length} active positions`));
  } catch (error) {
    console.error(chalk.red(`❌ Error saving state: ${error.message}`));
  }
}

// Record trade history
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
      metrics: serializableMetrics,
      result: serializableResult || null,
    });
    
    fs.writeFileSync(CONFIG.HISTORY_FILE, JSON.stringify(history, null, 2));
    console.log(chalk.green(`📝 Recorded ${action} trade for position ${position.id || "new"}`));
  } catch (err) {
    console.error(chalk.red(`❌ Error recording trade: ${err.message}`));
    console.error(chalk.red(`Stack trace: ${err.stack}`));
  }
}

// Get optimal leverage based on 24h price volatility
function getLeverageForAsset(denom, markets) {
  // Find market data for this asset
  const market = markets.find(m => m.denom === denom);
  if (!market) return CONFIG.LEVERAGE_NORMAL;
  
  // Extract 24h price change percentage
  const priceChange = Math.abs(parseFloat(market.day_change || 0));
  
  // Use lower leverage during high volatility periods
  if (priceChange > CONFIG.VOLATILITY_THRESHOLD) {
    console.log(chalk.yellow(`🔥 High volatility detected for ${denom} (${priceChange.toFixed(2)}%), using reduced leverage`));
    return CONFIG.LEVERAGE_HIGH_VOL;
  }
  
  return CONFIG.LEVERAGE_NORMAL;
}

// Extract position ID from transaction result
function extractPositionId(result) {
  if (!result || !result.events) return null;
  
  try {
    // Multiple approaches to extract position ID
    const events = JSON.stringify(result.events);
    
    // Approach 1: Look for position_id pattern
    const match = events.match(/position_id[\"']?:[\s]*[\"']?(\d+)/);
    if (match && match[1]) {
      return match[1];
    }
    
    // Approach 2: Parse events to find position ID
    if (result.events.length > 0) {
      for (const event of result.events) {
        if (event.type === 'wasm' && event.attributes) {
          for (const attr of event.attributes) {
            if (attr.key === 'position_id') {
              return attr.value;
            }
          }
        }
      }
    }
    
    return null;
  } catch (e) {
    console.error(chalk.red(`❌ Error extracting position ID: ${e.message}`));
    return null;
  }
}

// Find funding rate opportunities
function findFundingOpportunities(enabledMarkets, fundingRates, state) {
  const opportunities = [];
  const now = Date.now();
  
  console.log(chalk.blue(`🔍 Analyzing ${enabledMarkets.length} markets for funding opportunities...`));
  
  // Debug: print first few funding rate entries to see structure
  console.log(chalk.gray("📊 First few funding rates entries:"));
  let counter = 0;
  for (const [key, value] of Object.entries(fundingRates)) {
    if (counter++ < 3) {
      console.log(chalk.gray(`   ${key}: ${JSON.stringify(value)}`));
    }
  }
  
  // Process each enabled market
  for (const market of enabledMarkets) {
    const denom = market.denom;
    
    // Skip blacklisted assets
    if (state.assetBlacklist && state.assetBlacklist[denom] && state.assetBlacklist[denom] > now) {
      console.log(chalk.gray(`Skipping ${denom}: blacklisted until ${new Date(state.assetBlacklist[denom]).toLocaleString()}`));
      continue;
    }
    
    // Check if funding rate data exists for this market
    if (!fundingRates || !fundingRates[denom]) {
      console.log(chalk.gray(`Skipping ${denom}: no funding data available`));
      continue;
    }
    
    // Skip if we already have a position for this asset
    let alreadyTrading = false;
    if (state.positions) {
      for (const posId in state.positions) {
        if (state.positions[posId].denom === denom) {
          alreadyTrading = true;
          break;
        }
      }
    }
    
    if (alreadyTrading) {
      console.log(chalk.gray(`Skipping ${denom}: already have an active position`));
      continue;
    }
    
    // Safely access funding rate with fallback
    const fundingRate = fundingRates[denom]?.fundingRate;
    
    // Skip if funding rate is undefined or too small
    if (fundingRate === undefined || Math.abs(fundingRate) < CONFIG.MIN_FUNDING_ENTRY) {
      console.log(chalk.gray(`Skipping ${denom}: funding rate ${fundingRate === undefined ? 'undefined' : fundingRate.toFixed(2) + '%'} below threshold ${CONFIG.MIN_FUNDING_ENTRY}%`));
      continue;
    }
    
    // Extract OI data with safety checks
    let longOI = 0;
    let shortOI = 0;
    
    try {
      longOI = parseFloat(fundingRates[denom]?.longOI || 0);
      shortOI = parseFloat(fundingRates[denom]?.shortOI || 0);
    } catch (error) {
      console.log(chalk.yellow(`⚠️ Error parsing OI data for ${denom}: ${error.message}`));
    }
    
    // Calculate OI imbalance with safety checks
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
      console.log(chalk.gray(`Skipping ${denom}: OI imbalance ${oiImbalance.toFixed(2)} below threshold ${CONFIG.MIN_OI_IMBALANCE}`));
      continue;
    }
    
    // Determine position direction based on funding rate sign
    // - Negative funding: longs are paid, so go long
    // - Positive funding: shorts are paid, so go short
    const isLong = fundingRate < 0;
    
    // Calculate opportunity score
    // Higher absolute funding + higher OI imbalance = better opportunity
    // Bonus if OI imbalance is in our favor (shorts > longs when we're shorting)
    let opportunityScore = Math.abs(fundingRate) * oiImbalance;
    
    // Apply bonus for favorable OI imbalance
    if ((isLong && oiDirection === "short") || (!isLong && oiDirection === "long")) {
      opportunityScore *= 1.2; // 20% bonus for favorable OI imbalance
    }
    
    // Prioritize higher liquidity if configured
    const liquidity = parseFloat(market.total_open_interest || 0);
    if (CONFIG.PRIORITIZE_HIGH_LIQUIDITY && liquidity > 0) {
      // Scale by log of liquidity to avoid overweighting just on size
      opportunityScore *= (1 + Math.log10(Math.max(liquidity, 1)) / 10);
    }
    
    opportunities.push({
      denom,
      fundingRate,
      isLong,
      oiImbalance,
      oiDirection,
      longOI,
      shortOI,
      score: opportunityScore,
      leverage: getLeverageForAsset(denom, enabledMarkets)
    });
    
    console.log(chalk.green(`✨ Found opportunity: ${denom} (${isLong ? 'LONG' : 'SHORT'})`));
    console.log(chalk.green(`  Funding Rate: ${fundingRate.toFixed(2)}%, OI Imbalance: ${oiImbalance.toFixed(2)}x (${oiDirection || 'N/A'})`));
  }
  
  // Sort by opportunity score (highest first)
  return opportunities.sort((a, b) => b.score - a.score);
}

// Open a position with retry logic
async function openYieldPosition(opportunity, attempt = 0) {
  const { denom, isLong, leverage } = opportunity;
  
  if (CONFIG.DRY_RUN) {
    console.log(chalk.yellow(`[DRY RUN] Would open ${isLong ? 'LONG' : 'SHORT'} position for ${denom} at ${leverage}x leverage`));
    return { dryRun: true };
  }
  
  console.log(chalk.blue(`🔓 Opening ${isLong ? 'LONG' : 'SHORT'} position for ${denom} at ${leverage}x leverage...`));
  
  // Create asset payload - single asset position
  const assets = [
    { denom: denom, long: isLong, percent: "1.0" }
  ];
  
  try {
    const result = await openPosition(assets, leverage, CONFIG.COLLATERAL);
    console.log(chalk.green(`Position opened successfully with ${leverage}x leverage and ${CONFIG.COLLATERAL} USDC`));
    return result;
  } catch (err) {
    if (err.message && err.message.includes("account sequence mismatch") && attempt < 2) {
      console.log(chalk.yellow("Sequence mismatch detected - refreshing client and retrying..."));
      await new Promise((resolve) => setTimeout(resolve, 10000)); // Wait 10 seconds
      await getClient(); // Refresh client
      return await openYieldPosition(opportunity, attempt + 1);
    }
    console.error(chalk.red(`❌ Error opening position: ${err.message}`));
    throw err;
  }
}

// Close a position with retry logic
async function closeYieldPosition(positionId, attempt = 0) {
  if (CONFIG.DRY_RUN) {
    console.log(chalk.yellow(`[DRY RUN] Would close position ${positionId}`));
    return { dryRun: true, positionId };
  }
  
  console.log(chalk.blue(`🔒 Closing position ${positionId}...`));
  
  try {
    const result = await closePosition(positionId);
    console.log(chalk.green(`Position ${positionId} closed successfully`));
    return result;
  } catch (err) {
    if (err.message && err.message.includes("account sequence mismatch") && attempt < 2) {
      console.log(chalk.yellow("Sequence mismatch detected - refreshing client and retrying..."));
      await new Promise((resolve) => setTimeout(resolve, 10000)); // Wait 10 seconds
      await getClient(); // Refresh client
      return await closeYieldPosition(positionId, attempt + 1);
    }
    console.error(chalk.red(`❌ Error closing position ${positionId}: ${err.message}`));
    throw err;
  }
}

// Check exit conditions for a position
async function checkExitConditions(position, positionState, fundingRates) {
  const positionId = position.id;
  
  if (!positionState) return { shouldExit: false };
  
  // 1. Check max hold time
  const holdTimeHours = (Date.now() - positionState.entryTimestamp) / (1000 * 60 * 60);
  if (holdTimeHours > CONFIG.MAX_POSITION_HOLD_HOURS) {
    console.log(chalk.yellow(`⏰ Position ${positionId} reached max hold time (${holdTimeHours.toFixed(1)} hours)`));
    return { shouldExit: true, reason: "max_hold_time" };
  }
  
  // 2. Check PnL for take profit or stop loss
  let pnlPct = null;
  try {
    // Try to get PnL from position object directly
    if (position.pnl_percent) {
      pnlPct = parseFloat(position.pnl_percent);
    } else {
      // Calculate PnL manually using current prices
      console.log(chalk.blue(`📊 Calculating PnL manually for position ${positionId}...`));
      
      // Fetch current prices
      const currentPrices = await getPrices();
      
      // Position must have assets array with at least one asset
      if (position.assets && position.assets.length > 0) {
        let totalPnl = 0;
        
        // Calculate PnL for each asset in the position
        for (const asset of position.assets) {
          const denom = asset.denom;
          const isLong = asset.long;
          const execPrice = parseFloat(asset.exec_price || 0);
          
          // Skip if we don't have execution price
          if (!execPrice) {
            console.log(chalk.yellow(`⚠️ Missing execution price for ${denom} in position ${positionId}`));
            continue;
          }
          
          // Get current price
          const currentPrice = parseFloat(currentPrices[denom] || 0);
          
          // Skip if we don't have current price
          if (!currentPrice) {
            console.log(chalk.yellow(`⚠️ Missing current price for ${denom}`));
            continue;
          }
          
          // Calculate asset PnL percentage
          let assetPnlPct = 0;
          if (isLong) {
            // For long: (current - entry) / entry
            assetPnlPct = ((currentPrice - execPrice) / execPrice) * 100;
          } else {
            // For short: (entry - current) / entry
            assetPnlPct = ((execPrice - currentPrice) / execPrice) * 100;
          }
          
          console.log(chalk.gray(`   ${denom}: ${isLong ? 'LONG' : 'SHORT'} @ ${execPrice}, current: ${currentPrice}, PnL: ${assetPnlPct.toFixed(2)}%`));
          
          // Calculate weighted contribution based on collateral percent
          const collateralPercent = parseFloat(asset.collateral_percent || 1.0);
          totalPnl += assetPnlPct * collateralPercent;
        }
        
        // Apply leverage to PnL calculation
        const leverage = parseFloat(position.leverage || 2.0);
        pnlPct = totalPnl * leverage;
        
        console.log(chalk.blue(`📊 Calculated total PnL for position ${positionId}: ${pnlPct.toFixed(2)}%`));
      } else {
        console.log(chalk.yellow(`⚠️ Position ${positionId} has no assets, cannot calculate PnL`));
        pnlPct = 0;
      }
    }
    
    // Take profit check
    if (pnlPct >= CONFIG.PROFIT_TARGET_PCT) {
      console.log(chalk.green(`💰 Position ${positionId} reached profit target: ${pnlPct.toFixed(2)}%`));
      return { shouldExit: true, reason: "profit_target", pnl: pnlPct };
    }
    
    // Stop loss check
    if (pnlPct <= -CONFIG.STOP_LOSS_PCT) {
      console.log(chalk.red(`🛑 Position ${positionId} hit stop loss: ${pnlPct.toFixed(2)}%`));
      return { shouldExit: true, reason: "stop_loss", pnl: pnlPct };
    }
  } catch (error) {
    console.error(chalk.red(`❌ Error getting PnL for position ${positionId}: ${error.message}`));
    console.error(chalk.red(`Stack trace: ${error.stack}`));
  }
  
  // 3. Check if funding rate has normalized
  if (fundingRates && fundingRates[positionState.denom]) {
    const currentFundingRate = fundingRates[positionState.denom].fundingRate;
    const entryFundingRate = positionState.entryFundingRate;
    
    // Skip if we don't have valid funding rates
    if (currentFundingRate === undefined || entryFundingRate === undefined) {
      console.log(chalk.yellow(`⚠️ Position ${positionId}: Missing funding rate data, skipping funding check`));
    }
    // Exit if funding rate drops below our exit threshold
    else if (Math.abs(currentFundingRate) < CONFIG.MIN_FUNDING_EXIT) {
      console.log(chalk.yellow(`📉 Position ${positionId} funding rate has normalized`));
      console.log(chalk.yellow(`  Entry: ${entryFundingRate.toFixed(2)}%, Current: ${currentFundingRate.toFixed(2)}%`));
      return { shouldExit: true, reason: "funding_normalized", pnl: pnlPct };
    }
    // Exit if funding rate direction flips (strong signal to reverse)
    else if ((entryFundingRate > 0 && currentFundingRate < 0) || 
        (entryFundingRate < 0 && currentFundingRate > 0)) {
      console.log(chalk.yellow(`↕️ Position ${positionId} funding rate direction has flipped`));
      console.log(chalk.yellow(`  Entry: ${entryFundingRate.toFixed(2)}%, Current: ${currentFundingRate.toFixed(2)}%`));
      return { shouldExit: true, reason: "funding_direction_change", pnl: pnlPct };
    }
  }
  
  return { shouldExit: false, pnl: pnlPct };
}

// Clean up state by removing positions that no longer exist
function cleanupState(state, currentPositionList) {
  console.log(chalk.blue(`🧹 Cleaning up state. Before: ${Object.keys(state.positions).length} total positions in state`));
  
  // First, migrate any existing positions to have the strategy property
  let migratedCount = 0;
  
  // Get a list of active position IDs from the API
  const currentPositionIds = currentPositionList.map(pos => pos.id.toString());
  
  // Counter for cleanup stats
  let removedCount = 0;
  
  // First pass - mark our positions explicitly
  // Only positions we know are managed by this strategy 
  // Position IDs: 13756, 13755, 13754 (from current logs)
  for (const positionId in state.positions) {
    // Only explicitly mark these 3 positions
    if (['13756', '13755', '13754'].includes(positionId)) {
      if (!state.positions[positionId].hasOwnProperty('strategy')) {
        state.positions[positionId].strategy = 'yield-harvester';
        migratedCount++;
      }
    }
  }
  
  if (migratedCount > 0) {
    console.log(chalk.yellow(`⚠️ Migrated ${migratedCount} existing positions to include strategy property`));
  }
  
  // Second pass - clean up
  const keysToDelete = [];
  for (const positionId in state.positions) {
    // We should remove an entry if:
    // 1. It's not in the current API positions list (it's closed/doesn't exist)
    // 2. It's marked as belonging to yield-harvester OR has no strategy property (cleanup legacy entries)
    if (!currentPositionIds.includes(positionId) && 
        (state.positions[positionId]?.strategy === 'yield-harvester' || 
         !state.positions[positionId]?.hasOwnProperty('strategy'))) {
      keysToDelete.push(positionId);
    }
  }
  
  // Delete the positions outside the loop to avoid modifying the object during iteration
  for (const positionId of keysToDelete) {
    delete state.positions[positionId];
    removedCount++;
  }
  
  const strategyPositions = Object.keys(state.positions)
    .filter(id => state.positions[id]?.strategy === 'yield-harvester')
    .length;
  
  console.log(chalk.green(`✅ State cleanup complete. Removed ${removedCount} stale positions.`));
  console.log(chalk.green(`✅ Current state: ${Object.keys(state.positions).length} total positions, ${strategyPositions} tracked by Yield Harvester`));
  
  return state;
}

// Main execution function
async function run() {
  try {
    console.log(chalk.blue("\n" + "=".repeat(50)));
    console.log(chalk.blue(`🤖 Yield Harvester Strategy - ${new Date().toLocaleString()}`));
    console.log(chalk.blue("=".repeat(50)));
    
    // 1. Initialize client
    console.log(chalk.blue("🔌 Initializing connection to BullBear..."));
    const client = await getClient();
    console.log(chalk.green(`✅ Connected to BullBear. Address: ${client.myAddress}`));
    
    // 2. Check USDC balance
    console.log(chalk.blue("💰 Checking USDC balance..."));
    const balance = await getBalance();
    console.log(chalk.green(`💰 USDC Balance: ${balance}`));
    
    if (balance < CONFIG.COLLATERAL) {
      console.error(chalk.red(`❌ Insufficient balance (${balance} USDC). Need at least ${CONFIG.COLLATERAL} USDC.`));
      return;
    }
    
    // 3. Load state
    console.log(chalk.blue("📂 Loading strategy state..."));
    let state = loadState();
    
    // 4. Get enabled markets
    console.log(chalk.blue("🌐 Fetching available markets..."));
    let allMarkets = [];
    try {
      allMarkets = await getMarkets();
      console.log(chalk.blue(`📊 Received ${allMarkets.length} total markets from API`));
      
      // Debug: log all markets to help diagnose issues
      if (CONFIG.DEBUG) {
        allMarkets.forEach(market => {
          console.log(chalk.gray(`Market: ${market.denom}, Display: ${market.display || 'N/A'}`));
        });
      }
    } catch (error) {
      console.error(chalk.red(`❌ Error fetching markets: ${error.message}`));
      console.error(chalk.red(`Stack trace: ${error.stack}`));
      return;
    }
    
    if (!allMarkets || !Array.isArray(allMarkets)) {
      console.error(chalk.red(`❌ Invalid markets data: ${JSON.stringify(allMarkets)}`));
      return;
    }
    
    // Consider all markets enabled unless explicitly disabled
    // Since the API doesn't seem to have an 'enabled' field, we'll consider all markets as valid
    const validMarkets = allMarkets.filter(market => market && market.denom && market.denom.startsWith('perps/'));
    console.log(chalk.blue(`📊 Found ${validMarkets.length} valid perps markets out of ${allMarkets.length} total`));
    
    // Log all valid markets
    if (validMarkets.length > 0) {
      console.log(chalk.green("✅ Valid markets:"));
      validMarkets.forEach(market => {
        console.log(chalk.green(`   - ${market.denom} (${market.display || 'Unknown'})`));
      });
    } else {
      console.error(chalk.red(`❌ No valid markets found. API response may be incorrect.`));
      console.log(chalk.yellow(`⚠️ Raw markets data sample: ${JSON.stringify(allMarkets.slice(0, 2))}`));
      return;
    }
    
    // 5. Get funding rates
    console.log(chalk.blue("💹 Fetching funding rates..."));
    let fundingRates = {};
    try {
      fundingRates = await getFundingRates() || {};
      const fundingRateCount = Object.keys(fundingRates).length;
      console.log(chalk.blue(`📈 Received funding data for ${fundingRateCount} assets`));
      
      // Debug funding rate data structure
      console.log(chalk.gray("📊 Funding rates data structure:"));
      console.log(chalk.gray(JSON.stringify(fundingRates).substring(0, 200) + "..."));
      
      // Log funding rates for debug purposes
      if (CONFIG.DEBUG && fundingRateCount > 0) {
        console.log(chalk.green("📈 Current funding rates:"));
        Object.entries(fundingRates).forEach(([denom, data]) => {
          console.log(chalk.green(`   - ${denom}: ${data.fundingRate ? data.fundingRate.toFixed(2) + '%' : 'N/A'}`));
        });
      }
      
      if (fundingRateCount === 0) {
        console.log(chalk.yellow(`⚠️ Warning: No funding rate data available, but continuing...`));
      }
    } catch (error) {
      console.error(chalk.red(`❌ Error fetching funding rates: ${error.message}`));
      console.error(chalk.red(`Stack trace: ${error.stack}`));
      console.log(chalk.yellow(`⚠️ Continuing without funding rate data...`));
    }
    
    // 6. Manage positions
    console.log(chalk.blue("🔄 Starting position management..."));
    await managePositions(state, validMarkets, fundingRates);
    
    // 7. Update last run timestamp
    state.lastRun = Date.now();
    saveState(state);
    
    console.log(chalk.green("✅ Yield Harvester Strategy run completed"));
    console.log(chalk.blue("=".repeat(50) + "\n"));
  } catch (error) {
    console.error(chalk.red(`❌ Fatal error: ${error.message}`));
    console.error(chalk.red(`Stack trace: ${error.stack}`));
  }
}

// Manage existing positions
async function managePositions(state, enabledMarkets, fundingRates) {
  console.log(chalk.blue("⚙️ Starting position management process..."));
  
  // 1. Get current open positions
  console.log(chalk.blue("🔍 Fetching open positions..."));
  let openPositions = [];
  try {
    openPositions = await getPositions();
    const trackedPositions = Object.keys(state.positions).filter(id => 
      state.positions[id]?.strategy === 'yield-harvester'
    ).length;
    
    console.log(chalk.blue(`📋 Found ${openPositions.length} open positions, ${trackedPositions} tracked by Yield Harvester`));
    
    // Debug: log position details
    if (CONFIG.DEBUG && openPositions.length > 0) {
      console.log(chalk.green("📋 Current open positions:"));
      openPositions.forEach(pos => {
        const isTracked = state.positions[pos.id]?.strategy === 'yield-harvester';
        console.log(chalk.green(`   - ID: ${pos.id}, ${isTracked ? '✅ Tracked' : '❌ Not tracked'}, Assets: ${JSON.stringify(pos.assets)}`));
      });
    }
    
    // Clean up positions in state that don't exist anymore
    state = cleanupState(state, openPositions);
    saveState(state);
  } catch (error) {
    console.error(chalk.red(`❌ Error fetching positions: ${error.message}`));
    console.log(chalk.yellow(`⚠️ Continuing with other tasks...`));
    openPositions = [];
  }
  
  // 2. Check for positions to exit
  if (openPositions.length > 0) {
    console.log(chalk.blue("🔍 Checking positions for exit conditions..."));
  }
  
  // Process existing positions
  for (const position of openPositions) {
    const positionId = position.id;
    
    // Skip positions not managed by this strategy
    if (!state.positions[positionId] || state.positions[positionId]?.strategy !== 'yield-harvester') {
      if (CONFIG.DEBUG) {
        console.log(chalk.gray(`Position ${positionId} not managed by Yield Harvester, skipping`));
      }
      continue;
    }
    
    console.log(chalk.blue(`🔍 Evaluating position ${positionId} for exit conditions...`));
    
    // Check if we should exit this position
    const exitCheck = await checkExitConditions(position, state.positions[positionId], fundingRates);
    if (exitCheck.shouldExit) {
      try {
        console.log(chalk.yellow(`🚪 Closing position ${positionId} - Reason: ${exitCheck.reason}, PnL: ${exitCheck.pnl ? exitCheck.pnl.toFixed(2) + '%' : 'unknown'}`));
        const result = await closeYieldPosition(positionId);
        
        // Record the closed trade
        recordTrade(position, "close", result, {
          reason: exitCheck.reason,
          pnl: exitCheck.pnl,
          holdTimeHours: (Date.now() - state.positions[positionId].entryTimestamp) / (1000 * 60 * 60)
        });
        
        // Add asset to blacklist to prevent immediate re-entry
        // (temporary cooldown period to avoid churn)
        const blacklistExpiration = Date.now() + (6 * 60 * 60 * 1000); // 6 hours
        state.assetBlacklist[state.positions[positionId].denom] = blacklistExpiration;
        console.log(chalk.blue(`🔒 Blacklisted ${state.positions[positionId].denom} until ${new Date(blacklistExpiration).toLocaleString()}`));
        
        // Remove from state
        delete state.positions[positionId];
        saveState(state);
      } catch (error) {
        console.error(chalk.red(`❌ Failed to close position ${positionId}: ${error.message}`));
      }
    } else if (CONFIG.DEBUG) {
      console.log(chalk.gray(`Position ${positionId} - Current PnL: ${exitCheck.pnl !== null ? exitCheck.pnl.toFixed(2) + '%' : 'unknown'}, holding...`));
    }
  }
  
  // 3. Look for new positions to open (if we're under the max position limit)
  const currentPositionCount = Object.keys(state.positions)
    .filter(id => state.positions[id]?.strategy === 'yield-harvester')
    .length;
    
  if (currentPositionCount >= CONFIG.MAX_POSITIONS) {
    console.log(chalk.blue(`🔒 Already at max positions (${currentPositionCount}/${CONFIG.MAX_POSITIONS}). Not opening new positions.`));
    return;
  }
  
  // 4. Find funding rate opportunities
  console.log(chalk.blue("🔍 Searching for funding rate opportunities..."));
  const opportunities = findFundingOpportunities(enabledMarkets, fundingRates, state);
  
  if (opportunities.length === 0) {
    console.log(chalk.blue("😴 No funding rate opportunities found that meet criteria."));
    return;
  }
  
  console.log(chalk.blue(`💡 Found ${opportunities.length} potential opportunities.`));
  
  // 5. Open new positions with the best opportunities
  const availableSlots = CONFIG.MAX_POSITIONS - currentPositionCount;
  const opportunitiesToTake = opportunities.slice(0, availableSlots);
  
  console.log(chalk.blue(`🎯 Taking top ${opportunitiesToTake.length} opportunities...`));
  
  for (const opportunity of opportunitiesToTake) {
    try {
      console.log(chalk.blue(`🚀 Opening position for ${opportunity.denom} (${opportunity.isLong ? 'LONG' : 'SHORT'}) with funding rate ${opportunity.fundingRate.toFixed(2)}%`));
      
      // Open the position
      const result = await openYieldPosition(opportunity);
      
      // Extract position ID from result
      let positionId = extractPositionId(result);
      if (positionId) {
        console.log(chalk.green(`✅ Successfully extracted position ID: ${positionId}`));
      } else {
        console.log(chalk.yellow(`⚠️ Could not extract position ID from result. Raw event data: ${JSON.stringify(result.events || {})}`));
      }
      
      if (positionId || CONFIG.DRY_RUN) {
        // For dry runs, use a fake position ID
        if (CONFIG.DRY_RUN) {
          positionId = `dry-run-${Date.now()}`;
        }
        
        if (positionId) {
          // Save position data to state
          state.positions[positionId] = {
            id: positionId,
            denom: opportunity.denom,
            isLong: opportunity.isLong,
            entryFundingRate: opportunity.fundingRate,
            entryTimestamp: Date.now(),
            leverage: opportunity.leverage,
            collateral: CONFIG.COLLATERAL,
            strategy: 'yield-harvester' // Mark this position as belonging to this strategy
          };
          
          saveState(state);
          
          // Record the opened trade
          recordTrade({
            id: positionId,
            denom: opportunity.denom,
            isLong: opportunity.isLong
          }, "open", result, {
            fundingRate: opportunity.fundingRate,
            oiImbalance: opportunity.oiImbalance,
            oiDirection: opportunity.oiDirection,
            score: opportunity.score
          });
          
          console.log(chalk.green(`✅ Successfully opened position ${positionId}`));
        } else {
          console.log(chalk.yellow("⚠️ Position opened but could not determine position ID"));
        }
      }
    } catch (error) {
      console.error(chalk.red(`❌ Failed to open position for ${opportunity.denom}: ${error.message}`));
      console.error(chalk.red(`Stack trace: ${error.stack}`));
    }
  }
}

// Run the strategy
if (require.main === module) {
  console.log(chalk.green("🚀 Starting Yield Harvester Strategy"));
  run().catch(console.error);
} else {
  module.exports = { run };
} 