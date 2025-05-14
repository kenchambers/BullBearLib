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
  Volatility Breakout Hunter (VBH) Strategy
  -------------------------------------------------------
  Core concept:
    • Monitors market for sudden increases in price volatility
    • Identifies assets breaking out of recent price ranges
    • Takes positions in the direction of confirmed breakouts
    • Applies dynamic position sizing based on volatility levels
    • Uses trailing stops for exits to capture extended moves
*/

// ---------- CONFIGURATION ----------
const CONFIG = {
  // Strategy parameters
  COLLATERAL: 10.1, // USDC collateral per trade (slightly above $10 min to cover gas)
  BASE_LEVERAGE: 2.0, // Base leverage level, adjusted dynamically
  MAX_LEVERAGE: 3.0, // Maximum allowed leverage
  MAX_POSITIONS: 3, // Maximum concurrent positions
  
  // Volatility detection
  VOLATILITY_WINDOW: 24, // How many price points to use for volatility calc
  MIN_VOLATILITY_THRESHOLD: 0.03, // Minimum volatility for trade consideration (3%)
  VOLATILITY_BREAKOUT_FACTOR: 1.5, // How much volatility should increase to signal breakout
  
  // Breakout confirmation
  BREAKOUT_THRESHOLD: 0.02, // Min price movement required (2%)
  PRICE_RANGE_PERIODS: 24, // Periods to establish trading range
  CONFIRMATION_CANDLES: 2, // Number of consecutive candles needed to confirm
  
  // Position management
  TRAILING_STOP_INITIAL: 0.04, // Initial trailing stop distance (4%)
  TRAILING_STOP_STEP: 0.01, // How much to move trailing stop on favorable moves
  PROFIT_LOCK_THRESHOLD: 0.06, // When to start moving trailing stop (6% profit)
  MAX_POSITION_HOURS: 48, // Maximum hold time (2 days)
  
  // Risk management
  STOP_LOSS_PERCENT: 0.05, // 5% fixed stop loss
  MAX_POSITIONS_PER_ASSET: 1, // Only one position per asset
  
  // Operational settings
  STATE_FILE: path.join(CACHE_DIR, "vbh-state.json"),
  HISTORY_FILE: path.join(CACHE_DIR, "vbh-history.json"),
  PRICE_HISTORY_LENGTH: 72, // Store last 72 price data points
  SAMPLING_INTERVAL_MINUTES: 10, // How often to sample price data
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
    positions: {},  // { positionId: { createdAt, assets, entryPrices, trailingStop } }
    priceHistory: {}, // { denom: [{ timestamp, price }, ...] }
    volatilityHistory: {}, // { denom: [{ timestamp, volatility }, ...] }
    breakoutData: {}, // { denom: { direction, strength, confirmed, priceRange } }
    activeSamples: {}, // { denom: { lastSampleTime, consecutiveCandles, direction } }
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
      metrics: serializableMetrics, // Additional metrics like volatility values, breakout strength, etc.
      result: serializableResult || null,
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
  const timestamp = Date.now();
  
  // Initialize history objects if needed
  if (!state.priceHistory) state.priceHistory = {};
  if (!state.volatilityHistory) state.volatilityHistory = {};
  if (!state.breakoutData) state.breakoutData = {};
  if (!state.activeSamples) state.activeSamples = {};
  
  // Update price history
  for (const [denom, price] of Object.entries(prices)) {
    // Update price history
    if (!state.priceHistory[denom]) {
      state.priceHistory[denom] = [];
    }
    
    // Check if we should add a new sample (based on sampling interval)
    const lastSample = state.priceHistory[denom][state.priceHistory[denom].length - 1];
    const timeElapsed = !lastSample ? Infinity : (timestamp - lastSample.timestamp) / (1000 * 60); // minutes
    
    if (timeElapsed >= CONFIG.SAMPLING_INTERVAL_MINUTES) {
      state.priceHistory[denom].push({ timestamp, price: parseFloat(price) });
      
      // Keep only the specified history length
      if (state.priceHistory[denom].length > CONFIG.PRICE_HISTORY_LENGTH) {
        state.priceHistory[denom] = state.priceHistory[denom].slice(-CONFIG.PRICE_HISTORY_LENGTH);
      }
      
      // Calculate and update volatility if we have enough data
      if (state.priceHistory[denom].length >= CONFIG.VOLATILITY_WINDOW) {
        updateVolatility(state, denom);
      }
      
      // Update breakout data
      if (state.priceHistory[denom].length >= CONFIG.PRICE_RANGE_PERIODS) {
        updateBreakoutData(state, denom);
      }
    }
  }
  
  // Update last run timestamp
  state.lastRun = timestamp;
  
  return state;
}

// ---------- ANALYSIS FUNCTIONS ----------
function calculateStandardDeviation(values) {
  const n = values.length;
  if (n <= 1) return 0;
  
  const mean = values.reduce((sum, val) => sum + val, 0) / n;
  const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / (n - 1);
  
  return Math.sqrt(variance);
}

function calculateVolatility(priceHistory, periods) {
  if (!priceHistory || priceHistory.length < periods) return 0;
  
  // Get the last 'periods' prices
  const prices = priceHistory.slice(-periods).map(p => parseFloat(p.price));
  
  // Calculate log returns
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i-1] > 0 && prices[i] > 0) {
      returns.push(Math.log(prices[i] / prices[i-1]));
    }
  }
  
  // Calculate volatility as standard deviation of returns
  return calculateStandardDeviation(returns);
}

function updateVolatility(state, denom) {
  if (!state.volatilityHistory[denom]) {
    state.volatilityHistory[denom] = [];
  }
  
  const volatility = calculateVolatility(state.priceHistory[denom], CONFIG.VOLATILITY_WINDOW);
  
  state.volatilityHistory[denom].push({
    timestamp: Date.now(),
    volatility
  });
  
  // Keep only the most recent volatility readings
  if (state.volatilityHistory[denom].length > CONFIG.PRICE_HISTORY_LENGTH) {
    state.volatilityHistory[denom] = state.volatilityHistory[denom].slice(-CONFIG.PRICE_HISTORY_LENGTH);
  }
  
  if (CONFIG.DEBUG) {
    console.log(chalk.gray(`Updated volatility for ${denom}: ${(volatility * 100).toFixed(2)}%`));
  }
}

function calculatePriceRange(priceHistory, periods) {
  if (!priceHistory || priceHistory.length < periods) return { min: 0, max: 0 };
  
  const recentPrices = priceHistory.slice(-periods).map(p => parseFloat(p.price));
  
  return {
    min: Math.min(...recentPrices),
    max: Math.max(...recentPrices)
  };
}

function updateBreakoutData(state, denom) {
  const prices = state.priceHistory[denom];
  
  if (prices.length < CONFIG.PRICE_RANGE_PERIODS + 1) {
    return;
  }
  
  // Calculate recent price range
  const priceRange = calculatePriceRange(prices.slice(0, -1), CONFIG.PRICE_RANGE_PERIODS);
  const rangeWidth = priceRange.max - priceRange.min;
  
  // Get current price
  const currentPrice = parseFloat(prices[prices.length - 1].price);
  
  // Determine if we have a breakout
  let direction = null;
  let strength = 0;
  
  if (currentPrice > priceRange.max) {
    direction = "up";
    strength = (currentPrice - priceRange.max) / rangeWidth;
  } else if (currentPrice < priceRange.min) {
    direction = "down";
    strength = (priceRange.min - currentPrice) / rangeWidth;
  }
  
  // Check for confirmation
  let confirmed = false;
  if (!state.activeSamples[denom]) {
    state.activeSamples[denom] = {
      lastSampleTime: Date.now(),
      consecutiveCandles: direction ? 1 : 0,
      direction: direction
    };
  } else {
    // Update consecutive candle count for confirmation
    if (direction && direction === state.activeSamples[denom].direction) {
      state.activeSamples[denom].consecutiveCandles += 1;
      state.activeSamples[denom].lastSampleTime = Date.now();
    } else if (direction) {
      // Direction changed, reset counter
      state.activeSamples[denom].consecutiveCandles = 1;
      state.activeSamples[denom].direction = direction;
      state.activeSamples[denom].lastSampleTime = Date.now();
    } else {
      // No breakout, reset counter
      state.activeSamples[denom].consecutiveCandles = 0;
      state.activeSamples[denom].direction = null;
    }
    
    // Check if we have confirmation
    confirmed = state.activeSamples[denom].consecutiveCandles >= CONFIG.CONFIRMATION_CANDLES;
  }
  
  // Store breakout data
  state.breakoutData[denom] = {
    direction,
    strength,
    confirmed,
    priceRange,
    lastUpdated: Date.now()
  };
  
  if (CONFIG.DEBUG && direction) {
    console.log(chalk.yellow(`${denom} breakout detected: ${direction.toUpperCase()}, strength: ${(strength * 100).toFixed(2)}%, confirmed: ${confirmed}`));
  }
}

function calculateVolatilityRatio(state, denom) {
  if (!state.volatilityHistory[denom] || state.volatilityHistory[denom].length < 2) {
    return 1.0;
  }
  
  // Get current volatility
  const currentVolatility = state.volatilityHistory[denom][state.volatilityHistory[denom].length - 1].volatility;
  
  // Get average of previous volatility (excluding the most recent one)
  const previousVolatilities = state.volatilityHistory[denom].slice(0, -1).slice(-CONFIG.VOLATILITY_WINDOW);
  
  if (previousVolatilities.length === 0) return 1.0;
  
  const avgPreviousVolatility = previousVolatilities.reduce((sum, v) => sum + v.volatility, 0) / previousVolatilities.length;
  
  // Return ratio of current to previous average
  return avgPreviousVolatility !== 0 ? (currentVolatility / avgPreviousVolatility) : 1.0;
}

function findBreakoutOpportunities(state, enabledMarkets) {
  const opportunities = [];
  
  for (const market of enabledMarkets) {
    const denom = market.denom;
    
    // Skip if we don't have enough data
    if (!state.priceHistory[denom] || 
        state.priceHistory[denom].length < CONFIG.PRICE_RANGE_PERIODS || 
        !state.volatilityHistory[denom] || 
        state.volatilityHistory[denom].length < 2 ||
        !state.breakoutData[denom]) {
      continue;
    }
    
    // Get current volatility
    const latestVolatility = state.volatilityHistory[denom][state.volatilityHistory[denom].length - 1].volatility;
    
    // Check for minimum volatility threshold
    if (latestVolatility < CONFIG.MIN_VOLATILITY_THRESHOLD) {
      continue;
    }
    
    // Check for volatility spike
    const volatilityRatio = calculateVolatilityRatio(state, denom);
    const isVolatilityBreakout = volatilityRatio >= CONFIG.VOLATILITY_BREAKOUT_FACTOR;
    
    // Check for price breakout
    const { direction, strength, confirmed } = state.breakoutData[denom];
    
    // We need both a confirmed price breakout and a volatility breakout
    if (confirmed && isVolatilityBreakout && strength >= CONFIG.BREAKOUT_THRESHOLD) {
      const currentPrice = state.priceHistory[denom][state.priceHistory[denom].length - 1].price;
      
      // Calculate dynamic leverage based on volatility strength
      // Lower volatility = higher leverage, higher volatility = lower leverage
      const volatilityFactor = Math.min(1, CONFIG.MIN_VOLATILITY_THRESHOLD / latestVolatility);
      const dynamicLeverage = Math.min(CONFIG.MAX_LEVERAGE, CONFIG.BASE_LEVERAGE * volatilityFactor).toFixed(1);
      
      opportunities.push({
        denom,
        direction, // "up" or "down"
        strength,
        volatility: latestVolatility,
        volatilityRatio,
        currentPrice,
        leverage: dynamicLeverage,
        score: strength * volatilityRatio // Combined score for ranking
      });
    }
  }
  
  // Sort by combined score (descending)
  return opportunities.sort((a, b) => b.score - a.score);
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
    return { shouldExit: true, reason: "max_hold_time" };
  }
  
  // 2. Check for trailing stop or fixed stop loss
  let totalPnlPercent = 0;
  let maxPnlReached = positionState.maxPnlReached || 0;
  
  for (const asset of position.assets) {
    // Get current price
    if (!state.priceHistory[asset.denom] || state.priceHistory[asset.denom].length === 0) continue;
    
    const currentPrice = parseFloat(state.priceHistory[asset.denom][state.priceHistory[asset.denom].length - 1].price);
    const entryPrice = parseFloat(positionState.entryPrices[asset.denom]);
    
    if (!entryPrice || entryPrice === 0) continue;
    
    // Calculate price change
    const priceChange = (currentPrice - entryPrice) / entryPrice;
    const assetPnlPercent = asset.long ? priceChange : -priceChange;
    
    // Weight by position percentage
    const weight = parseFloat(asset.percent);
    totalPnlPercent += assetPnlPercent * weight;
  }
  
  // Update max profit reached (for trailing stop calculation)
  if (totalPnlPercent > maxPnlReached) {
    maxPnlReached = totalPnlPercent;
    state.positions[positionId].maxPnlReached = maxPnlReached;
    saveState(state);
  }
  
  // Check for stop loss (fixed)
  if (totalPnlPercent <= -CONFIG.STOP_LOSS_PERCENT) {
    console.log(chalk.red(`Position ${positionId} hit stop loss: ${(totalPnlPercent * 100).toFixed(2)}%`));
    return { shouldExit: true, reason: "stop_loss" };
  }
  
  // Check for trailing stop (once profit has reached the lock threshold)
  if (maxPnlReached >= CONFIG.PROFIT_LOCK_THRESHOLD) {
    // Calculate current trailing stop level
    const trailingStopLevel = Math.max(0, maxPnlReached - CONFIG.TRAILING_STOP_INITIAL);
    
    if (totalPnlPercent <= trailingStopLevel) {
      console.log(chalk.yellow(`Position ${positionId} hit trailing stop: Current PnL ${(totalPnlPercent * 100).toFixed(2)}%, Max PnL ${(maxPnlReached * 100).toFixed(2)}%`));
      return { shouldExit: true, reason: "trailing_stop" };
    }
  }
  
  return { shouldExit: false };
}

async function openBreakoutPosition(opportunity, attempt = 0) {
  if (CONFIG.DRY_RUN) {
    console.log(chalk.yellow(`[DRY RUN] Would open ${opportunity.direction === 'up' ? 'LONG' : 'SHORT'} position on ${opportunity.denom} with leverage ${opportunity.leverage}`));
    return { dryRun: true, txHash: `dry-run-${Date.now()}` };
  }
  
  try {
    // Create assets array - for breakout strategy, we go 100% in the direction of the breakout
    const assets = [
      {
        denom: opportunity.denom,
        long: opportunity.direction === 'up',
        percent: "1.0" // Full position in one direction
      }
    ];
    
    console.log(chalk.blue(`Opening ${opportunity.direction === 'up' ? 'LONG' : 'SHORT'} position on ${opportunity.denom} with leverage ${opportunity.leverage}`));
    
    const result = await openPosition(assets, opportunity.leverage, CONFIG.COLLATERAL);
    console.log(chalk.green(`Position opened successfully`));
    return result;
  } catch (err) {
    if (err.message && err.message.includes("account sequence mismatch") && attempt < 2) {
      console.log(chalk.yellow("Sequence mismatch detected - refreshing client and retrying..."));
      await new Promise((resolve) => setTimeout(resolve, 10000)); // Wait 10 seconds
      await getClient(); // Refresh client
      return await openBreakoutPosition(opportunity, attempt + 1);
    }
    console.error(chalk.red(`Error opening position: ${err.message}`));
    throw err;
  }
}

async function closeBreakoutPosition(positionId, attempt = 0) {
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
      return await closeBreakoutPosition(positionId, attempt + 1);
    }
    console.error(chalk.red(`Error closing position ${positionId}: ${err.message}`));
    throw err;
  }
}

// ---------- MAIN STRATEGY LOGIC ----------
async function managePositions(state, enabledMarkets) {
  try {
    // 1. Get current open positions
    const openPositions = await getPositions();
    const activeAssets = new Set();
    
    // Map our positions to their assets for tracking
    for (const position of openPositions) {
      if (state.positions[position.id]) {
        for (const asset of position.assets) {
          activeAssets.add(asset.denom);
        }
      }
    }
    
    // 2. Check for positions to exit
    for (const position of openPositions) {
      const positionId = position.id;
      
      // Skip positions not managed by this strategy
      if (!state.positions[positionId]) continue;
      
      // Check if we should exit this position
      const { shouldExit, reason } = await checkExitConditions(position, state);
      if (shouldExit) {
        try {
          const result = await closeBreakoutPosition(positionId);
          
          // Record the closed trade
          recordTrade(position, "close", result, { 
            exitReason: reason,
            pnl: state.positions[positionId].maxPnlReached
          });
          
          // Remove from state
          delete state.positions[positionId];
          saveState(state);
          
          console.log(chalk.green(`Successfully closed position ${positionId} due to ${reason}`));
        } catch (error) {
          console.error(chalk.red(`Failed to close position ${positionId}: ${error.message}`));
        }
      }
    }
    
    // 3. Look for new positions to open (if we're under the max position limit)
    const currentPositionCount = Object.keys(state.positions).length;
    if (currentPositionCount >= CONFIG.MAX_POSITIONS) {
      console.log(chalk.blue(`Already at max positions (${currentPositionCount}/${CONFIG.MAX_POSITIONS}). Not opening new positions.`));
      return;
    }
    
    // 4. Find opportunities
    const opportunities = findBreakoutOpportunities(state, enabledMarkets);
    
    if (opportunities.length === 0) {
      console.log(chalk.blue("No breakout opportunities found that meet criteria."));
      return;
    }
    
    console.log(chalk.blue(`Found ${opportunities.length} potential breakout opportunities.`));
    if (CONFIG.DEBUG && opportunities.length > 0) {
      console.log(chalk.blue("Top opportunity:"));
      console.log(JSON.stringify(opportunities[0], null, 2));
    }
    
    // 5. Open new positions with the best opportunities (up to available slots)
    const availableSlots = CONFIG.MAX_POSITIONS - currentPositionCount;
    let positionsOpened = 0;
    
    for (const opportunity of opportunities) {
      // Enforce asset limit (one position per asset)
      if (activeAssets.has(opportunity.denom)) {
        console.log(chalk.yellow(`Already have an active position for ${opportunity.denom}, skipping.`));
        continue;
      }
      
      // Open position
      try {
        const result = await openBreakoutPosition(opportunity);
        
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
          // Store position data in state
          if (CONFIG.DRY_RUN) {
            positionId = `dry-run-${Date.now()}`;
          }
          
          // Record entry prices
          const entryPrices = {};
          entryPrices[opportunity.denom] = opportunity.currentPrice;
          
          // Save position to state
          state.positions[positionId] = {
            createdAt: Date.now(),
            assets: [{
              denom: opportunity.denom,
              long: opportunity.direction === 'up',
              percent: "1.0"
            }],
            entryPrices,
            maxPnlReached: 0
          };
          
          saveState(state);
          
          // Record the opened trade
          recordTrade({
            id: positionId,
            assets: [{
              denom: opportunity.denom,
              long: opportunity.direction === 'up',
              percent: "1.0"
            }]
          }, "open", result, { 
            volatility: opportunity.volatility,
            volatilityRatio: opportunity.volatilityRatio,
            strength: opportunity.strength,
            leverage: opportunity.leverage
          });
          
          // Mark this asset as active
          activeAssets.add(opportunity.denom);
          
          console.log(chalk.green(`Successfully opened position ${positionId} for ${opportunity.denom} breakout`));
          
          // Increment counter
          positionsOpened++;
          
          // Stop if we've opened enough positions
          if (positionsOpened >= availableSlots) {
            break;
          }
        }
      } catch (error) {
        console.error(chalk.red(`Failed to open position for ${opportunity.denom}: ${error.message}`));
      }
    }
  } catch (error) {
    console.error(chalk.red(`Error in managePositions: ${error.message}`));
  }
}

// ---------- MAIN FUNCTION ----------
async function main() {
  try {
    console.log(chalk.blue("Starting Volatility Breakout Hunter Strategy"));
    
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
    await managePositions(state, enabledMarkets);
    
    console.log(chalk.green("Volatility Breakout Hunter Strategy run completed"));
  } catch (error) {
    console.error(chalk.red(`Fatal error: ${error.message}`));
  }
}

// Export the main function for the runner
if (require.main === module) {
  main().catch(console.error);
} else {
  module.exports = { main };
} 