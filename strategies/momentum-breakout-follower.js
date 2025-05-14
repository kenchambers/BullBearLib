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
  getMaxLeverages,
  getFundingRates
} = require("../lib");
const { CACHE_DIR } = require("../consts");

/*
  -------------------------------------------------------
  Momentum Breakout Follower (MBF) Strategy
  -------------------------------------------------------
  Core concept:
    • Tracks price changes for all available assets
    • Identifies assets with strong directional momentum
    • Takes positions in the direction of confirmed breakouts
    • Uses either single-asset positions or complementary asset balancing
    • Applies profit targets and stop losses for risk management
    • Biased toward INIT going up (long bias when possible)
*/

// ---------- CONFIGURATION ----------
const CONFIG = {
  // Strategy parameters
  COLLATERAL: 10.1, // USDC collateral per trade (slightly above $10 min to cover gas)
  LEVERAGE: "2", // Moderate leverage for controlled risk
  MAX_POSITIONS: 3, // Maximum concurrent positions
  
  // Momentum detection
  MOMENTUM_WINDOW: 3, // Number of price points to detect momentum
  BREAKOUT_THRESHOLD: 0.015, // 1.5% minimum price movement to detect breakout
  LONG_BIAS_FACTOR: 0.8, // Threshold reduction factor for long trades (increases long bias)
  
  // Position management
  TAKE_PROFIT_PERCENT: 0.05, // 5% profit target
  STOP_LOSS_PERCENT: 0.03, // 3% stop loss
  MAX_POSITION_HOURS: 24, // Maximum hold time
  MAX_POSITIONS_PER_ASSET: 1, // Only one position per asset
  
  // Position creation mode
  // - "single": Single-asset positions (100% allocation)
  // - "balanced": 50/50 split between primary and complementary assets
  POSITION_MODE: "single",
  
  // Default asset when no opposite momentum detected (for balanced positions)
  DEFAULT_PAIR_ASSET: "perps/uusdc", // Use USDC as default pair
  
  // Operational settings
  STATE_FILE: path.join(CACHE_DIR, "mbf-state.json"),
  HISTORY_FILE: path.join(CACHE_DIR, "mbf-history.json"),
  PRICE_HISTORY_LENGTH: 10, // Store more price points for better trend analysis
  BLACKLIST_EXPIRY_HOURS: 8, // Time before an asset can be traded again
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
    positions: {},  // { positionId: { createdAt, assets, entryPrices } }
    priceHistory: {}, // { denom: [{ timestamp, price }, ...] }
    assetBlacklist: [], // Assets we've recently traded
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
      metrics: serializableMetrics,
      result: serializableResult || null,
    });
    
    fs.writeFileSync(CONFIG.HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (err) {
    console.error(chalk.red("Error recording trade:", err.message));
  }
}

// ---------- PRICE & MARKET TRACKING ----------
async function updateMarketData(state) {
  // Get current prices
  const prices = await getPrices();
  const timestamp = Date.now();
  
  // Initialize history objects if needed
  if (!state.priceHistory) state.priceHistory = {};
  
  // Update price history
  for (const [denom, price] of Object.entries(prices)) {
    if (!state.priceHistory[denom]) {
      state.priceHistory[denom] = [];
    }
    
    // Check if we should add a new price point based on time elapsed
    let shouldAddPrice = true;
    
    // Only add time-based checks if we have at least one price point already
    if (state.priceHistory[denom].length > 0) {
      const lastPricePoint = state.priceHistory[denom][state.priceHistory[denom].length - 1];
      const timeElapsed = timestamp - lastPricePoint.timestamp;
      
      // Only add a new price point if at least 1 hour has passed (3600000 ms)
      // or if the price has changed significantly (> 0.5%)
      const priceChange = Math.abs((price - lastPricePoint.price) / lastPricePoint.price);
      shouldAddPrice = timeElapsed > 3600000 || priceChange > 0.005;
      
      if (CONFIG.DEBUG && !shouldAddPrice) {
        console.log(chalk.gray(`Skipping price update for ${denom}: last update ${Math.floor(timeElapsed/60000)}m ago, change: ${(priceChange*100).toFixed(2)}%`));
      }
    }
    
    // Add current price point if conditions met
    if (shouldAddPrice) {
      state.priceHistory[denom].push({ timestamp, price });
      
      if (CONFIG.DEBUG) {
        console.log(chalk.gray(`Added price point for ${denom}: ${price}`));
      }
      
      // Keep only the specified history length
      if (state.priceHistory[denom].length > CONFIG.PRICE_HISTORY_LENGTH) {
        state.priceHistory[denom] = state.priceHistory[denom].slice(-CONFIG.PRICE_HISTORY_LENGTH);
      }
    }
  }
  
  // Update last run timestamp
  state.lastRun = timestamp;
  
  return state;
}

// ---------- ANALYSIS FUNCTIONS ----------
function calculatePriceChange(priceHistory) {
  if (!priceHistory || priceHistory.length < 2) return 0;
  
  // More sophisticated price change calculation considering time weights
  // Recent price movements have more significance than older ones
  
  // Get latest price point
  const newest = parseFloat(priceHistory[priceHistory.length - 1].price);
  const newestTime = priceHistory[priceHistory.length - 1].timestamp;
  
  // Get oldest price point
  const oldest = parseFloat(priceHistory[0].price);
  const oldestTime = priceHistory[0].timestamp;
  
  // Basic percentage change calculation
  if (oldest === 0) return 0;
  const rawChange = (newest - oldest) / oldest;
  
  // Calculate time span in hours (normalize by time to get annualized rate)
  const timeSpanHours = (newestTime - oldestTime) / (1000 * 60 * 60);
  if (timeSpanHours < 0.5) {
    // If less than 30 minutes of data, don't annualize (avoid division by small numbers)
    return rawChange;
  }
  
  // Normalize change based on time - effectively calculating hourly rate
  // but capped to avoid extreme values from very short intervals
  const normalizedChange = Math.min(rawChange / timeSpanHours, rawChange * 2);
  
  // Add exponential weighting to recent price movements
  let weightedChange = 0;
  let totalWeight = 0;
  
  for (let i = 1; i < priceHistory.length; i++) {
    const current = parseFloat(priceHistory[i].price);
    const previous = parseFloat(priceHistory[i-1].price);
    
    if (previous === 0) continue;
    
    const segmentChange = (current - previous) / previous;
    // More recent changes get higher weight
    const weight = Math.pow(1.5, i); // Exponential weighting
    
    weightedChange += segmentChange * weight;
    totalWeight += weight;
  }
  
  // Combine raw normalized change with weighted recent momentum
  const combinedChange = totalWeight > 0 
    ? (normalizedChange * 0.6) + ((weightedChange / totalWeight) * 0.4)
    : normalizedChange;
    
  return combinedChange;
}

// Get blacklisted assets as a Set for efficient lookups
function getBlacklistedAssets(state) {
  const blacklistedAssets = new Set();
  const now = Date.now();
  const expiryTime = CONFIG.BLACKLIST_EXPIRY_HOURS * 60 * 60 * 1000;
  
  // Clean up and collect current blacklisted assets
  state.assetBlacklist = state.assetBlacklist.filter(item => {
    // Handle both old format (string) and new format (object with timestamp)
    if (typeof item === 'string') {
      return false; // Remove old format items
    } else if (typeof item === 'object' && item.timestamp) {
      const stillBlacklisted = now - item.timestamp < expiryTime;
      if (stillBlacklisted) blacklistedAssets.add(item.denom);
      return stillBlacklisted;
    }
    return false;
  });
  
  return blacklistedAssets;
}

// Clean up state by removing positions that no longer exist on the blockchain
function cleanupState(state, currentPositionList) {
  console.log(chalk.blue(`🧹 Cleaning up state. Before: ${Object.keys(state.positions).length} total positions in state`));
  
  // Get a list of active position IDs from the blockchain
  const currentPositionIds = currentPositionList.map(pos => pos.id.toString());
  
  // Counter for cleanup stats
  let removedCount = 0;
  
  // Remove positions that don't exist on the blockchain anymore
  const keysToDelete = [];
  for (const positionId in state.positions) {
    if (!currentPositionIds.includes(positionId)) {
      keysToDelete.push(positionId);
    }
  }
  
  // Delete the positions outside the loop to avoid modifying during iteration
  for (const positionId of keysToDelete) {
    delete state.positions[positionId];
    removedCount++;
  }
  
  console.log(chalk.green(`✅ State cleanup complete. Removed ${removedCount} stale positions.`));
  console.log(chalk.green(`✅ Current state: ${Object.keys(state.positions).length} total positions`));
  
  return state;
}

function findBreakoutOpportunities(state, enabledMarkets, fundingRates) {
  const opportunities = [];
  const blacklistedAssets = getBlacklistedAssets(state);
  
  if (CONFIG.DEBUG) {
    console.log(chalk.yellow(`Asset blacklist: ${Array.from(blacklistedAssets).join(', ') || 'empty'}`));
    console.log(chalk.yellow(`Available markets: ${enabledMarkets.map(m => m.denom).join(', ')}`));
  }
  
  // Find breakout opportunities
  for (const market of enabledMarkets) {
    const denom = market.denom;
    
    // Check if already trading this asset
    if (blacklistedAssets.has(denom)) {
      if (CONFIG.DEBUG) console.log(chalk.gray(`Skipping ${denom}: blacklisted`));
      continue;
    }
    
    // Skip assets that are already being traded
    let alreadyTrading = false;
    for (const positionId in state.positions) {
      const position = state.positions[positionId];
      if (position.assets.some(asset => asset.denom === denom)) {
        alreadyTrading = true;
        break;
      }
    }
    
    if (alreadyTrading) {
      if (CONFIG.DEBUG) console.log(chalk.gray(`Skipping ${denom}: already in an active position`));
      continue;
    }
    
    // Check if we have sufficient price history
    if (!state.priceHistory[denom] || state.priceHistory[denom].length < CONFIG.MOMENTUM_WINDOW) {
      if (CONFIG.DEBUG) console.log(chalk.gray(`Skipping ${denom}: insufficient price history`));
      continue;
    }
    
    // Calculate price change
    const priceChange = calculatePriceChange(state.priceHistory[denom]);
    
    if (CONFIG.DEBUG) {
      console.log(chalk.gray(`${denom} price change: ${(priceChange * 100).toFixed(2)}%`));
    }
    
    // Look for breakouts with long bias
    let direction;
    let breakout = false;
    
    // Long bias: Use reduced threshold for long positions
    const longThreshold = CONFIG.BREAKOUT_THRESHOLD * CONFIG.LONG_BIAS_FACTOR;
    const shortThreshold = CONFIG.BREAKOUT_THRESHOLD;
    
    if (priceChange > longThreshold) {
      direction = "long";
      breakout = true;
      console.log(chalk.green(`✨ Breakout detected for ${denom}: +${(priceChange * 100).toFixed(2)}% (LONG)`));
    } else if (priceChange < -shortThreshold) {
      direction = "short";
      breakout = true;
      console.log(chalk.red(`✨ Breakout detected for ${denom}: ${(priceChange * 100).toFixed(2)}% (SHORT)`));
    }
    
    if (breakout) {
      // Priority for INIT going up (special case)
      let priorityBonus = 0;
      if (denom.includes("uinit") && direction === "long") {
        priorityBonus = 0.5; // Boost priority for INIT longs
        console.log(chalk.blue(`🚀 Special INIT long opportunity detected with priority boost`));
      }
      
      // Add funding rate edge if available
      let fundingEdge = 0;
      if (fundingRates[denom]) {
        const fundingRate = fundingRates[denom].fundingRate;
        // Add bonus if funding direction aligns with our trade direction
        if ((direction === "long" && fundingRate < 0) || 
            (direction === "short" && fundingRate > 0)) {
          fundingEdge = Math.abs(fundingRate) / 100;
          console.log(chalk.blue(`💰 Favorable funding rate for ${denom}: ${fundingRate.toFixed(2)}%`));
        }
      }
      
      // Calculate strength (absolute price change + funding edge + priority bonus)
      const strength = Math.abs(priceChange) + fundingEdge + priorityBonus;
      
      opportunities.push({
        denom,
        direction,
        priceChange,
        strength,
        latestPrice: state.priceHistory[denom][state.priceHistory[denom].length - 1].price
      });
    }
  }
  
  // Sort by strength (highest first)
  return opportunities.sort((a, b) => b.strength - a.strength);
}

// Find complementary assets for balanced trades
function findComplementaryAsset(state, opportunity, enabledMarkets, fundingRates) {
  const primaryDenom = opportunity.denom;
  const primaryDirection = opportunity.direction;
  
  // If we're using single-asset positions, we don't need a complementary asset
  if (CONFIG.POSITION_MODE === "single") {
    return null;
  }
  
  // Try to find an asset with opposite momentum
  const oppositeOpportunities = [];
  const blacklistedAssets = getBlacklistedAssets(state);
  
  for (const market of enabledMarkets) {
    const denom = market.denom;
    
    // Skip the primary asset
    if (denom === primaryDenom) continue;
    
    // Skip blacklisted assets
    if (blacklistedAssets.has(denom)) continue;
    
    // Skip assets that are already being traded
    let alreadyTrading = false;
    for (const positionId in state.positions) {
      const position = state.positions[positionId];
      if (position.assets.some(asset => asset.denom === denom)) {
        alreadyTrading = true;
        break;
      }
    }
    
    if (alreadyTrading) continue;
    
    // Skip if we don't have price history
    if (!state.priceHistory[denom] || state.priceHistory[denom].length < CONFIG.MOMENTUM_WINDOW) continue;
    
    // Calculate price change in opposite direction
    const priceChange = calculatePriceChange(state.priceHistory[denom]);
    const oppositeDirection = primaryDirection === "long" ? "short" : "long";
    
    // Check if this asset is moving in the opposite direction
    if ((oppositeDirection === "long" && priceChange > 0) || 
        (oppositeDirection === "short" && priceChange < 0)) {
      
      // Consider funding rates for better pairing
      let fundingEdge = 0;
      if (fundingRates[denom]) {
        const fundingRate = fundingRates[denom].fundingRate;
        if ((oppositeDirection === "long" && fundingRate < 0) || 
            (oppositeDirection === "short" && fundingRate > 0)) {
          fundingEdge = Math.abs(fundingRate) / 100;
        }
      }
      
      oppositeOpportunities.push({
        denom,
        direction: oppositeDirection,
        strength: Math.abs(priceChange) + fundingEdge,
        latestPrice: state.priceHistory[denom][state.priceHistory[denom].length - 1].price
      });
    }
  }
  
  // If we found opposite momentum assets, choose the strongest one
  if (oppositeOpportunities.length > 0) {
    oppositeOpportunities.sort((a, b) => b.strength - a.strength);
    console.log(chalk.blue(`Found complementary asset: ${oppositeOpportunities[0].denom} (${oppositeOpportunities[0].direction})`));
    return oppositeOpportunities[0];
  }
  
  // If no opposite momentum, use USDC or the same asset with opposite direction
  console.log(chalk.yellow(`No complementary asset found. Using USDC as default pair.`));
  return {
    denom: CONFIG.DEFAULT_PAIR_ASSET,
    direction: "long", // USDC is always long
    strength: 0,
    latestPrice: "1.0" // USDC price is always 1
  };
}

// ---------- POSITION MANAGEMENT ----------
async function checkExitConditions(position, state) {
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
    // Get current price
    if (!state.priceHistory[asset.denom] || state.priceHistory[asset.denom].length === 0) continue;
    
    const currentPrice = parseFloat(state.priceHistory[asset.denom][state.priceHistory[asset.denom].length - 1].price);
    const entryPrice = parseFloat(positionState.entryPrices[asset.denom]);
    
    if (!entryPrice || entryPrice === 0) continue;
    
    // Calculate price change
    const priceChange = (currentPrice - entryPrice) / entryPrice;
    const assetPnlPercent = asset.long ? priceChange : -priceChange;
    
    // Weight by position percentage (convert from string)
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
  
  return { shouldExit: false, pnl: totalPnlPercent };
}

async function openMomentumPosition(client, assets, attempt = 0) {
  if (CONFIG.DRY_RUN) {
    console.log(chalk.yellow(`[DRY RUN] Would open position with assets: ${JSON.stringify(assets)}`));
    return { dryRun: true };
  }
  
  try {
    console.log(chalk.blue(`Opening position with ${CONFIG.LEVERAGE}x leverage and ${CONFIG.COLLATERAL} USDC`));
    const result = await openPosition(assets, CONFIG.LEVERAGE, CONFIG.COLLATERAL);
    console.log(chalk.green(`Position opened successfully`));
    return result;
  } catch (err) {
    if (err.message && err.message.includes("account sequence mismatch") && attempt < 2) {
      console.log(chalk.yellow("Sequence mismatch detected - refreshing client and retrying..."));
      await new Promise((resolve) => setTimeout(resolve, 10000)); // Wait 10 seconds
      await getClient(); // Refresh client
      return await openMomentumPosition(client, assets, attempt + 1);
    }
    console.error(chalk.red(`Error opening position: ${err.message}`));
    throw err;
  }
}

async function closeMomentumPosition(positionId, attempt = 0) {
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
      return await closeMomentumPosition(positionId, attempt + 1);
    }
    console.error(chalk.red(`Error closing position ${positionId}: ${err.message}`));
    throw err;
  }
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
    console.error(chalk.red(`Error extracting position ID: ${e.message}`));
    return null;
  }
}

// ---------- MAIN STRATEGY LOGIC ----------
async function managePositions(client, state, enabledMarkets) {
  // Get funding rates for additional signal
  const fundingRates = await getFundingRates();
  
  // 1. Get current open positions
  const openPositions = await getPositions();
  console.log(chalk.blue(`Found ${openPositions.length} open positions, ${Object.keys(state.positions).length} tracked by MBF strategy`));
  
  // Clean up state to remove positions that don't exist on-chain anymore
  state = cleanupState(state, openPositions);
  saveState(state);
  
  // 2. Check for positions to exit
  for (const position of openPositions) {
    const positionId = position.id;
    
    // Skip positions not managed by this strategy
    if (!state.positions[positionId]) {
      if (CONFIG.DEBUG) {
        console.log(chalk.gray(`Position ${positionId} not managed by MBF strategy, skipping`));
      }
      continue;
    }
    
    // Check if we should exit this position
    const exitCheck = await checkExitConditions(position, state);
    if (exitCheck.shouldExit) {
      try {
        console.log(chalk.yellow(`Closing position ${positionId} - Reason: ${exitCheck.reason}, PnL: ${exitCheck.pnl ? (exitCheck.pnl * 100).toFixed(2) + '%' : 'unknown'}`));
        const result = await closeMomentumPosition(positionId);
        
        // Record the closed trade
        recordTrade(position, "close", result, {
          reason: exitCheck.reason,
          pnl: exitCheck.pnl,
          holdTimeHours: (Date.now() - state.positions[positionId].createdAt) / (1000 * 60 * 60)
        });
        
        // Remove from state
        delete state.positions[positionId];
        
        // Add assets to blacklist to prevent immediate re-entry
        for (const asset of position.assets) {
          if (asset.denom.startsWith('perps/')) { // Only blacklist perps assets, not USDC
            state.assetBlacklist.push({
              denom: asset.denom,
              timestamp: Date.now()
            });
            console.log(chalk.blue(`Blacklisted ${asset.denom} for ${CONFIG.BLACKLIST_EXPIRY_HOURS} hours`));
          }
        }
        
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
  
  // 4. Find opportunities
  const opportunities = findBreakoutOpportunities(state, enabledMarkets, fundingRates);
  
  if (opportunities.length === 0) {
    console.log(chalk.blue("No opportunities found that meet criteria."));
    return;
  }
  
  console.log(chalk.blue(`Found ${opportunities.length} potential opportunities.`));
  
  // 5. Open new positions with the best opportunities
  const availableSlots = CONFIG.MAX_POSITIONS - currentPositionCount;
  const opportunitiesToTake = opportunities.slice(0, availableSlots);
  
  for (const opportunity of opportunitiesToTake) {
    try {
      let assets;
      
      if (CONFIG.POSITION_MODE === "single") {
        // Single-asset position (100% allocation)
        assets = [
          {
            denom: opportunity.denom,
            long: opportunity.direction === "long",
            percent: "1.0"
          }
        ];
      } else {
        // Find complementary asset for balanced 50/50 position
        const complementary = findComplementaryAsset(state, opportunity, enabledMarkets, fundingRates);
        
        // Create balanced position assets
        assets = [
          {
            denom: opportunity.denom,
            long: opportunity.direction === "long",
            percent: "0.5"
          },
          {
            denom: complementary.denom,
            long: complementary.direction === "long", 
            percent: "0.5"
          }
        ];
      }
      
      console.log(chalk.blue(`Opening position with assets: ${JSON.stringify(assets)}`));
      
      // Open the position
      const result = await openMomentumPosition(client, assets);
      
      // Extract position ID from result
      let positionId = extractPositionId(result);
      
      if (positionId || CONFIG.DRY_RUN) {
        // Store entry prices
        const entryPrices = {};
        
        for (const asset of assets) {
          if (state.priceHistory[asset.denom] && state.priceHistory[asset.denom].length > 0) {
            entryPrices[asset.denom] = state.priceHistory[asset.denom][state.priceHistory[asset.denom].length - 1].price;
          } else if (asset.denom === CONFIG.DEFAULT_PAIR_ASSET) {
            entryPrices[asset.denom] = "1.0"; // USDC price is always 1
          }
          
          // Add assets to blacklist to avoid trading them again immediately
          if (asset.denom.startsWith('perps/')) { // Only blacklist perps assets, not USDC
            state.assetBlacklist.push({
              denom: asset.denom, 
              timestamp: Date.now()
            });
            console.log(chalk.blue(`Blacklisted ${asset.denom} for ${CONFIG.BLACKLIST_EXPIRY_HOURS} hours`));
          }
        }
        
        // Save to state
        if (CONFIG.DRY_RUN) {
          positionId = `dry-run-${Date.now()}`;
        }
        
        if (positionId) {
          state.positions[positionId] = {
            createdAt: Date.now(),
            assets,
            entryPrices
          };
          
          saveState(state);
          
          // Record the opened trade
          recordTrade({
            id: positionId,
            assets: assets
          }, "open", result, {
            breakoutStrength: opportunity.strength,
            priceChange: opportunity.priceChange,
            entryPrices
          });
          
          console.log(chalk.green(`Successfully opened position ${positionId}`));
        } else {
          console.log(chalk.yellow("Position opened but could not determine position ID"));
        }
      }
    } catch (error) {
      console.error(chalk.red(`Failed to open position: ${error.message}`));
    }
  }
}

// ---------- MAIN FUNCTION ----------
async function main() {
  try {
    console.log(chalk.blue("🚀 Starting Momentum Breakout Follower Strategy"));
    
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
    
    // 5. Update market data
    state = await updateMarketData(state);
    saveState(state);
    
    // 6. Manage positions
    await managePositions(client, state, enabledMarkets);
    
    console.log(chalk.green("✅ Momentum Breakout Follower Strategy run completed"));
  } catch (error) {
    console.error(chalk.red(`Fatal error: ${error.message}`));
  }
}

// Run the strategy
if (require.main === module) {
  main().catch(console.error);
} else {
  module.exports = { main };
} 