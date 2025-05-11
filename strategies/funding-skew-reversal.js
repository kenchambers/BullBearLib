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
  getFundingRates,
} = require("../lib");
const { CACHE_DIR } = require("../consts");

/*
  -------------------------------------------------------
  Funding-Skew Reversal (FSR) Strategy
  -------------------------------------------------------
  Core concept:
    • Identify assets with funding rates significantly misaligned with price action
    • These misalignments often predict reversals as market positioning becomes imbalanced
    • Strategy uses historical correlation between funding and price to detect skews
    • Takes long/short positions to capture the correction of these imbalances
*/

// ---------- CONFIGURATION ----------
const CONFIG = {
  // Strategy parameters
  COLLATERAL: 10.1, // USDC collateral per trade (slightly above $10 min to cover gas)
  MAX_LEVERAGE: 2.5, // Conservative leverage to manage risk
  MAX_POSITIONS: 3, // Maximum concurrent positions
  
  // Entry conditions
  MIN_FUNDING_SKEW: 15, // Minimum funding rate (annualized %) to consider significant
  SKEW_SIGNIFICANCE_THRESHOLD: 2.0, // How many standard deviations from normal correlation
  MIN_FUNDING_HISTORY_POINTS: 3, // Minimum data points required
  
  // Position management
  TAKE_PROFIT_PERCENT: 0.08, // 8% profit target
  STOP_LOSS_PERCENT: 0.05, // 5% stop loss
  MAX_POSITION_HOURS: 72, // Maximum hold time (3 days)
  FUNDING_REVERSAL_EXIT: true, // Exit if funding skew resolves
  
  // Blacklist management
  ASSET_BLACKLIST_HOURS: 6, // Hours to blacklist an asset after closing position
  MAX_POSITIONS_PER_ASSET: 1, // Only one position per asset
  
  // Operational settings
  STATE_FILE: path.join(CACHE_DIR, "fsr-state.json"),
  HISTORY_FILE: path.join(CACHE_DIR, "fsr-history.json"),
  FUNDING_HISTORY_LENGTH: 24, // Store last 24 funding rate data points
  PRICE_HISTORY_LENGTH: 24, // Store last 24 price data points
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
    priceHistory: {}, // { denom: [{ timestamp, price }, ...] }
    fundingRateHistory: {}, // { denom: [{ timestamp, rate }, ...] }
    assetBlacklist: {}, // { denom: expirationTimestamp }
    correlationMetrics: {}, // { denom: { mean, stdDev, lastUpdated } }
    lastRun: null // Timestamp of last full run
  };
}

function saveState(state) {
  try {
    fs.writeFileSync(CONFIG.STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error(chalk.red("Error saving state:", err.message));
  }
}

function recordTrade(position, action, result, metrics = {}) {
  try {
    let history = [];
    if (fs.existsSync(CONFIG.HISTORY_FILE)) {
      history = JSON.parse(fs.readFileSync(CONFIG.HISTORY_FILE, "utf8"));
    }
    
    history.push({
      timestamp: Date.now(),
      action, // "open" or "close"
      position,
      metrics, // Additional metrics like skew values, correlations, etc.
      result: result || null,
    });
    
    fs.writeFileSync(CONFIG.HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (err) {
    console.error(chalk.red("Error recording trade:", err.message));
  }
}

// ---------- MARKET DATA TRACKING ----------
async function updateMarketData(state) {
  // Get current prices
  const prices = await getPrices();
  const fundingRates = await getFundingRates();
  const timestamp = Date.now();
  
  // Initialize history objects if needed
  if (!state.priceHistory) state.priceHistory = {};
  if (!state.fundingRateHistory) state.fundingRateHistory = {};
  if (!state.correlationMetrics) state.correlationMetrics = {};
  
  // Update price and funding rate history
  for (const [denom, price] of Object.entries(prices)) {
    // Update price history
    if (!state.priceHistory[denom]) {
      state.priceHistory[denom] = [];
    }
    
    state.priceHistory[denom].push({ timestamp, price: parseFloat(price) });
    
    // Keep only the specified history length
    if (state.priceHistory[denom].length > CONFIG.PRICE_HISTORY_LENGTH) {
      state.priceHistory[denom] = state.priceHistory[denom].slice(-CONFIG.PRICE_HISTORY_LENGTH);
    }
    
    // Update funding rate history if available
    if (fundingRates[denom]) {
      if (!state.fundingRateHistory[denom]) {
        state.fundingRateHistory[denom] = [];
      }
      
      state.fundingRateHistory[denom].push({ 
        timestamp, 
        rate: fundingRates[denom].fundingRate,
        longOI: fundingRates[denom].longOI,
        shortOI: fundingRates[denom].shortOI
      });
      
      // Keep only the specified history length
      if (state.fundingRateHistory[denom].length > CONFIG.FUNDING_HISTORY_LENGTH) {
        state.fundingRateHistory[denom] = state.fundingRateHistory[denom].slice(-CONFIG.FUNDING_HISTORY_LENGTH);
      }
    }
  }
  
  // Update correlation metrics once we have enough data points
  for (const denom of Object.keys(state.fundingRateHistory)) {
    if (state.fundingRateHistory[denom].length >= CONFIG.MIN_FUNDING_HISTORY_POINTS && 
        state.priceHistory[denom] && 
        state.priceHistory[denom].length >= CONFIG.MIN_FUNDING_HISTORY_POINTS) {
      
      updateCorrelationMetrics(state, denom);
    }
  }
  
  // Update last run timestamp
  state.lastRun = timestamp;
  
  // Clean up expired blacklist items
  const now = Date.now();
  for (const [denom, expiration] of Object.entries(state.assetBlacklist || {})) {
    if (now > expiration) {
      delete state.assetBlacklist[denom];
      console.log(chalk.blue(`Removed ${denom} from blacklist (expired)`));
    }
  }
  
  return state;
}

// ---------- ANALYSIS FUNCTIONS ----------
function calculatePercentChange(currentValue, previousValue) {
  if (previousValue === 0) return 0;
  return (currentValue - previousValue) / Math.abs(previousValue);
}

function calculatePriceChange(priceHistory, periods = 1) {
  if (!priceHistory || priceHistory.length < periods + 1) return 0;
  
  const newestIndex = priceHistory.length - 1;
  const oldestIndex = Math.max(0, newestIndex - periods);
  
  const newest = priceHistory[newestIndex].price;
  const oldest = priceHistory[oldestIndex].price;
  
  return calculatePercentChange(newest, oldest);
}

function calculateStandardDeviation(values) {
  const n = values.length;
  if (n < 2) return 0;
  
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  const variance = values.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / (n - 1);
  
  return {
    mean,
    stdDev: Math.sqrt(variance)
  };
}

function updateCorrelationMetrics(state, denom) {
  // Get the aligned price and funding rate changes
  const { fundingRateChanges, priceChanges } = getFundingPriceChangesPairs(
    state.fundingRateHistory[denom],
    state.priceHistory[denom]
  );
  
  if (fundingRateChanges.length < CONFIG.MIN_FUNDING_HISTORY_POINTS) {
    return;
  }
  
  // Calculate the spreads (price change minus funding rate change)
  const spreads = fundingRateChanges.map((rate, i) => priceChanges[i] - rate);
  
  // Calculate standard deviation of spreads
  const { mean, stdDev } = calculateStandardDeviation(spreads);
  
  state.correlationMetrics[denom] = {
    mean,
    stdDev,
    lastUpdated: Date.now()
  };
  
  if (CONFIG.DEBUG) {
    console.log(chalk.blue(`Updated correlation metrics for ${denom}: mean=${mean.toFixed(4)}, stdDev=${stdDev.toFixed(4)}`));
  }
}

function getFundingPriceChangesPairs(fundingHistory, priceHistory) {
  // Get the aligned price and funding rate changes for correlation calculation
  const fundingRateChanges = [];
  const priceChanges = [];
  
  // Need at least 2 points to calculate changes
  if (fundingHistory.length < 2 || priceHistory.length < 2) {
    return { fundingRateChanges, priceChanges };
  }
  
  // Start from the second point to calculate changes
  for (let i = 1; i < fundingHistory.length; i++) {
    const currentRate = fundingHistory[i].rate;
    const previousRate = fundingHistory[i-1].rate;
    const rateChangeNormalized = (currentRate - previousRate) / 100; // Normalize by 100 since rates are in percent
    
    // Find closest price points to the funding rate timestamps
    const currentPricePoint = findClosestPricePoint(priceHistory, fundingHistory[i].timestamp);
    const previousPricePoint = findClosestPricePoint(priceHistory, fundingHistory[i-1].timestamp);
    
    if (currentPricePoint && previousPricePoint) {
      const priceChange = calculatePercentChange(currentPricePoint.price, previousPricePoint.price);
      
      fundingRateChanges.push(rateChangeNormalized);
      priceChanges.push(priceChange);
    }
  }
  
  return { fundingRateChanges, priceChanges };
}

function findClosestPricePoint(priceHistory, targetTimestamp) {
  if (!priceHistory || priceHistory.length === 0) return null;
  
  let closest = priceHistory[0];
  let minDiff = Math.abs(targetTimestamp - closest.timestamp);
  
  for (let i = 1; i < priceHistory.length; i++) {
    const diff = Math.abs(targetTimestamp - priceHistory[i].timestamp);
    if (diff < minDiff) {
      minDiff = diff;
      closest = priceHistory[i];
    }
  }
  
  return closest;
}

function getCurrentFundingSkew(state, denom) {
  if (!state.fundingRateHistory[denom] || 
      state.fundingRateHistory[denom].length < 1 ||
      !state.priceHistory[denom] ||
      state.priceHistory[denom].length < 2) {
    return { hasSkew: false };
  }
  
  // Get current funding rate
  const currentFundingRate = state.fundingRateHistory[denom][state.fundingRateHistory[denom].length - 1].rate;
  
  // Calculate recent price change (last 2 periods)
  const recentPriceChange = calculatePriceChange(state.priceHistory[denom], 2);
  
  // If funding rate is too small, there's no significant skew
  if (Math.abs(currentFundingRate) < CONFIG.MIN_FUNDING_SKEW) {
    return { hasSkew: false };
  }
  
  // Check for correlation metrics
  if (!state.correlationMetrics[denom] || !state.correlationMetrics[denom].stdDev) {
    return { hasSkew: false };
  }
  
  // Calculate the current spread (expected relationship)
  // For simplicity, we normalize the funding rate by dividing by 100 (as it's a percentage)
  const normalizedFundingRate = currentFundingRate / 100;
  const currentSpread = recentPriceChange - normalizedFundingRate;
  
  // Calculate how many standard deviations away from the mean
  const { mean, stdDev } = state.correlationMetrics[denom];
  const zScore = stdDev === 0 ? 0 : (currentSpread - mean) / stdDev;
  
  // Determine if there's a significant skew
  const hasSkew = Math.abs(zScore) > CONFIG.SKEW_SIGNIFICANCE_THRESHOLD;
  
  // Determine direction:
  // If z-score is significantly positive: price higher than expected given funding rate
  // If z-score is significantly negative: price lower than expected given funding rate
  let direction = null;
  
  if (hasSkew) {
    // If z-score is positive, it means current spread is larger than typical
    // If funding rate is positive (longs pay shorts), this suggests shorts might win
    // If funding rate is negative (shorts pay longs), this suggests longs might win
    if (zScore > 0) {
      direction = currentFundingRate > 0 ? "short" : "long";
    } else {
      direction = currentFundingRate > 0 ? "long" : "short";
    }
  }
  
  return {
    hasSkew,
    direction,
    zScore,
    currentFundingRate,
    recentPriceChange,
    currentSpread,
    expectedSpread: mean,
    longShortRatio: state.fundingRateHistory[denom][state.fundingRateHistory[denom].length - 1].longOI / 
                    state.fundingRateHistory[denom][state.fundingRateHistory[denom].length - 1].shortOI
  };
}

function findFundingSkewOpportunities(state, enabledMarkets) {
  const opportunities = [];
  
  for (const market of enabledMarkets) {
    const denom = market.denom;
    
    // Skip assets in blacklist
    if (state.assetBlacklist && state.assetBlacklist[denom]) {
      if (CONFIG.DEBUG) {
        console.log(chalk.gray(`Skipping ${denom}: blacklisted until ${new Date(state.assetBlacklist[denom]).toLocaleString()}`));
      }
      continue;
    }
    
    // Skip assets we already have positions in
    let hasExistingPosition = false;
    for (const positionId in state.positions) {
      const position = state.positions[positionId];
      if (position.assets.some(asset => asset.denom === denom)) {
        hasExistingPosition = true;
        break;
      }
    }
    
    if (hasExistingPosition && CONFIG.MAX_POSITIONS_PER_ASSET === 1) {
      if (CONFIG.DEBUG) {
        console.log(chalk.gray(`Skipping ${denom}: already have a position`));
      }
      continue;
    }
    
    // Check for funding skew
    const skewData = getCurrentFundingSkew(state, denom);
    
    if (skewData.hasSkew) {
      const strength = Math.abs(skewData.zScore) * Math.abs(skewData.currentFundingRate);
      
      opportunities.push({
        denom,
        display: market.display,
        direction: skewData.direction,
        strength,
        metrics: skewData
      });
      
      if (CONFIG.DEBUG) {
        console.log(chalk.green(`Found opportunity: ${denom} (${skewData.direction})`));
        console.log(chalk.green(`  Z-Score: ${skewData.zScore.toFixed(2)}, Funding Rate: ${skewData.currentFundingRate.toFixed(2)}%`));
        console.log(chalk.green(`  Long/Short Ratio: ${skewData.longShortRatio.toFixed(2)}`));
      }
    } else if (CONFIG.DEBUG) {
      console.log(chalk.gray(`No significant skew for ${denom}`));
    }
  }
  
  // Sort by strength (highest first)
  return opportunities.sort((a, b) => b.strength - a.strength);
}

// ---------- POSITION MANAGEMENT ----------
async function checkExitConditions(position, state) {
  const positionId = position.id;
  const positionState = state.positions[positionId];
  
  if (!positionState) return false;
  
  // 1. Check max hold time
  const holdTimeHours = (Date.now() - positionState.createdAt) / (1000 * 60 * 60);
  if (holdTimeHours > CONFIG.MAX_POSITION_HOURS) {
    console.log(chalk.yellow(`Position ${positionId} reached max hold time (${holdTimeHours.toFixed(1)} hours)`));
    return { shouldExit: true, reason: "MAX_HOLD_TIME" };
  }
  
  // 2. Check for take profit or stop loss
  let totalPnlPercent = 0;
  
  for (const asset of position.assets) {
    // Get current price
    if (!state.priceHistory[asset.denom] || state.priceHistory[asset.denom].length === 0) continue;
    
    const currentPrice = state.priceHistory[asset.denom][state.priceHistory[asset.denom].length - 1].price;
    const entryPrice = positionState.entryPrices[asset.denom];
    
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
    return { shouldExit: true, reason: "TAKE_PROFIT", pnl: totalPnlPercent };
  }
  
  // Stop loss check
  if (totalPnlPercent <= -CONFIG.STOP_LOSS_PERCENT) {
    console.log(chalk.red(`Position ${positionId} hit stop loss: ${(totalPnlPercent * 100).toFixed(2)}%`));
    return { shouldExit: true, reason: "STOP_LOSS", pnl: totalPnlPercent };
  }
  
  // 3. Check if funding skew has reverted (if enabled)
  if (CONFIG.FUNDING_REVERSAL_EXIT) {
    for (const asset of position.assets) {
      const denom = asset.denom;
      
      // Skip if not enough data
      if (!state.fundingRateHistory[denom] || state.fundingRateHistory[denom].length < 1) continue;
      
      const currentSkew = getCurrentFundingSkew(state, denom);
      const entryFundingRate = positionState.entryFundingRates[denom];
      
      // If skew direction has changed or magnitude has significantly decreased
      if (entryFundingRate) {
        const currentRate = state.fundingRateHistory[denom][state.fundingRateHistory[denom].length - 1].rate;
        
        // Check if funding rate has flipped sign (crossed zero)
        const crossedZero = (entryFundingRate > 0 && currentRate < 0) || (entryFundingRate < 0 && currentRate > 0);
        
        // Check if magnitude has decreased significantly
        const magnitudeReduction = Math.abs(currentRate) < Math.abs(entryFundingRate) * 0.3; // Reduced by 70% or more
        
        if (crossedZero || magnitudeReduction) {
          console.log(chalk.yellow(`Position ${positionId} funding skew has normalized`));
          console.log(chalk.yellow(`  Entry funding rate: ${entryFundingRate.toFixed(2)}%, Current: ${currentRate.toFixed(2)}%`));
          return { shouldExit: true, reason: "FUNDING_NORMALIZED", pnl: totalPnlPercent };
        }
        
        // Check if skew direction has reversed
        if (currentSkew.hasSkew && currentSkew.direction) {
          const positionDirection = asset.long ? "long" : "short";
          if (currentSkew.direction !== positionDirection) {
            console.log(chalk.yellow(`Position ${positionId} funding skew direction has reversed`));
            return { shouldExit: true, reason: "SKEW_REVERSAL", pnl: totalPnlPercent };
          }
        }
      }
    }
  }
  
  return { shouldExit: false, pnl: totalPnlPercent };
}

async function openFSRPosition(assets, attempt = 0) {
  if (CONFIG.DRY_RUN) {
    console.log(chalk.yellow(`[DRY RUN] Would open position with assets: ${JSON.stringify(assets)}`));
    return { dryRun: true };
  }
  
  try {
    const result = await openPosition(assets, CONFIG.MAX_LEVERAGE.toString(), CONFIG.COLLATERAL);
    console.log(chalk.green(`Position opened successfully with ${CONFIG.MAX_LEVERAGE}x leverage and ${CONFIG.COLLATERAL} USDC`));
    return result;
  } catch (err) {
    if (err.message && err.message.includes("account sequence mismatch") && attempt < 2) {
      console.log(chalk.yellow("Sequence mismatch detected - refreshing client and retrying..."));
      await new Promise((resolve) => setTimeout(resolve, 10000)); // Wait 10 seconds
      await getClient(); // Refresh client
      return await openFSRPosition(assets, attempt + 1);
    }
    console.error(chalk.red(`Error opening position: ${err.message}`));
    throw err;
  }
}

async function closeFSRPosition(positionId, attempt = 0) {
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
      return await closeFSRPosition(positionId, attempt + 1);
    }
    console.error(chalk.red(`Error closing position ${positionId}: ${err.message}`));
    throw err;
  }
}

// ---------- MAIN STRATEGY LOGIC ----------
async function managePositions(state, enabledMarkets) {
  console.log(chalk.blue("Starting position management..."));
  
  // 1. Get current open positions
  const openPositions = await getPositions();
  console.log(chalk.blue(`Found ${openPositions.length} open positions, ${Object.keys(state.positions).length} tracked by FSR strategy`));
  
  // 2. Check for positions to exit
  for (const position of openPositions) {
    const positionId = position.id;
    
    // Skip positions not managed by this strategy
    if (!state.positions[positionId]) {
      if (CONFIG.DEBUG) {
        console.log(chalk.gray(`Position ${positionId} not managed by FSR strategy, skipping`));
      }
      continue;
    }
    
    // Check if we should exit this position
    const exitCheck = await checkExitConditions(position, state);
    if (exitCheck.shouldExit) {
      try {
        console.log(chalk.yellow(`Closing position ${positionId} - Reason: ${exitCheck.reason}, PnL: ${(exitCheck.pnl * 100).toFixed(2)}%`));
        const result = await closeFSRPosition(positionId);
        
        // Record the closed trade
        recordTrade(position, "close", result, {
          reason: exitCheck.reason,
          pnl: exitCheck.pnl,
          holdTimeHours: (Date.now() - state.positions[positionId].createdAt) / (1000 * 60 * 60)
        });
        
        // Add assets to blacklist
        const blacklistExpiration = Date.now() + (CONFIG.ASSET_BLACKLIST_HOURS * 60 * 60 * 1000);
        for (const asset of position.assets) {
          state.assetBlacklist[asset.denom] = blacklistExpiration;
          console.log(chalk.blue(`Blacklisted ${asset.denom} until ${new Date(blacklistExpiration).toLocaleString()}`));
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
  
  // 4. Find skew opportunities
  const opportunities = findFundingSkewOpportunities(state, enabledMarkets);
  
  if (opportunities.length === 0) {
    console.log(chalk.blue("No funding skew opportunities found that meet criteria."));
    return;
  }
  
  console.log(chalk.blue(`Found ${opportunities.length} potential opportunities.`));
  
  // 5. Open a new position with the best opportunity
  const availableSlots = CONFIG.MAX_POSITIONS - currentPositionCount;
  const opportunitiesToTake = opportunities.slice(0, availableSlots);
  
  for (const opportunity of opportunitiesToTake) {
    try {
      // Create position with opportunity asset and a complementary asset or USDC
      const primaryAsset = {
        denom: opportunity.denom,
        long: opportunity.direction === "long",
        percent: "0.5"
      };
      
      // Try to find a complementary asset from our opportunities
      let complementaryAsset = null;
      for (const oppOpp of opportunities) {
        if (oppOpp.denom !== opportunity.denom && oppOpp.direction !== opportunity.direction) {
          complementaryAsset = {
            denom: oppOpp.denom,
            long: oppOpp.direction === "long",
            percent: "0.5"
          };
          break;
        }
      }
      
      // If no complementary asset found, use the same asset in opposite direction
      // This maximizes our exposure to funding rate differential
      if (!complementaryAsset) {
        complementaryAsset = {
          denom: opportunity.denom,
          long: opportunity.direction !== "long", // Opposite direction
          percent: "0.5"
        };
      }
      
      const assets = [primaryAsset, complementaryAsset];
      
      console.log(chalk.blue(`Opening position with assets: ${JSON.stringify(assets)}`));
      
      // Open the position
      const result = await openFSRPosition(assets);
      
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
          if (state.priceHistory[asset.denom] && state.priceHistory[asset.denom].length > 0) {
            entryPrices[asset.denom] = state.priceHistory[asset.denom][state.priceHistory[asset.denom].length - 1].price;
          }
          
          if (state.fundingRateHistory[asset.denom] && state.fundingRateHistory[asset.denom].length > 0) {
            entryFundingRates[asset.denom] = state.fundingRateHistory[asset.denom][state.fundingRateHistory[asset.denom].length - 1].rate;
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
          skewMetrics: opportunity.metrics,
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
    console.log(chalk.blue("Starting Funding-Skew Reversal (FSR) Strategy"));
    
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
    
    // 5. Update market data (prices and funding rates)
    state = await updateMarketData(state);
    saveState(state);
    
    // 6. Manage positions
    await managePositions(state, enabledMarkets);
    
    console.log(chalk.green("Funding-Skew Reversal (FSR) Strategy run completed"));
  } catch (error) {
    console.error(chalk.red(`Fatal error: ${error.message}`));
  }
}

// Run the strategy
if (require.main === module) {
  main().catch(console.error);
}

module.exports = { main }; 