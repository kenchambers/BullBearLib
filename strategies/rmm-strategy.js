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
} = require("./lib");
const { CACHE_DIR } = require("./consts");

/*
  -------------------------------------------------------
  Rapid Market Momentum (RMM) Strategy
  -------------------------------------------------------
  Idea:  
    • Demo-focused strategy that takes frequent trades
    • Minimal entry conditions for immediate execution
    • Opens multiple smaller-sized positions
    • Quick position rotation with short hold times
    • Combines price momentum with funding rate direction
*/

// ---------- CONFIGURATION ----------
const CONFIG = {
  // Strategy parameters
  COLLATERAL: 11, // USDC collateral per trade
  LEVERAGE: "2", // Moderate leverage for demo
  MAX_POSITIONS: 3, // Allow more concurrent positions for demo
  
  // Entry conditions (extremely relaxed for guaranteed demo execution)
  MIN_PRICE_CHANGE: 0.0001, // Just 0.01% price movement required (practically any movement)
  MIN_TRADING_VOLUME: 1, // Almost any volume is acceptable
  
  // Exit conditions
  TAKE_PROFIT_PERCENT: 0.05, // Small 5% profit target for quicker turnover
  STOP_LOSS_PERCENT: 0.03, // Tight 3% stop loss for demonstration
  MAX_POSITION_HOURS: 12, // Short hold time for demo purposes
  MAX_POSITIONS_PER_ASSET: 1, // Only one position per asset at a time
  
  // Operational settings
  STATE_FILE: path.join(CACHE_DIR, "rmm-state.json"),
  HISTORY_FILE: path.join(CACHE_DIR, "rmm-history.json"),
  PRICE_HISTORY_LENGTH: 2, // Very short lookback period for quick signals
  ROTATION_DELAY_MINUTES: 5, // Shorter time before rotating to a new set of assets
  FORCE_TRADE: true, // Always try to find a trade for demo purposes
  IGNORE_BLACKLIST: true, // For demo, ignore the blacklist if no other opportunities
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
    lastRotation: 0,  // Last time we rotated through assets
    assetBlacklist: [], // Assets we've recently traded
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

function recordTrade(position, action, result) {
  try {
    let history = [];
    if (fs.existsSync(CONFIG.HISTORY_FILE)) {
      history = JSON.parse(fs.readFileSync(CONFIG.HISTORY_FILE, "utf8"));
    }
    
    history.push({
      timestamp: Date.now(),
      action, // "open" or "close"
      position,
      result: result || null,
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
    
    state.priceHistory[denom].push({ timestamp, price });
    
    // Keep only the specified history length
    if (state.priceHistory[denom].length > CONFIG.PRICE_HISTORY_LENGTH) {
      state.priceHistory[denom] = state.priceHistory[denom].slice(-CONFIG.PRICE_HISTORY_LENGTH);
    }
  }
  
  // Update last run timestamp
  state.lastRun = timestamp;
  
  return state;
}

// ---------- ANALYSIS FUNCTIONS ----------
function calculatePriceChange(priceHistory) {
  if (!priceHistory || priceHistory.length < 2) return 0;
  
  const oldest = parseFloat(priceHistory[0].price);
  const newest = parseFloat(priceHistory[priceHistory.length - 1].price);
  
  if (oldest === 0) return 0;
  return (newest - oldest) / oldest;
}

function findDemoOpportunities(state, enabledMarkets, fundingRates) {
  // For demo purposes, we'll generate opportunities even more aggressively
  
  const opportunities = [];
  const assetBlacklistSet = new Set(state.assetBlacklist || []);
  
  if (CONFIG.DEBUG) {
    console.log(chalk.yellow(`Asset blacklist: ${Array.from(assetBlacklistSet).join(', ') || 'empty'}`));
    console.log(chalk.yellow(`Available markets: ${enabledMarkets.map(m => m.denom).join(', ')}`));
  }
  
  // Check if it's time to rotate to new assets
  const now = Date.now();
  const timeSinceRotation = (now - (state.lastRotation || 0)) / (1000 * 60);
  
  if (timeSinceRotation > CONFIG.ROTATION_DELAY_MINUTES) {
    // Time to rotate, clear blacklist
    console.log(chalk.blue("Rotation time reached, clearing asset blacklist"));
    state.assetBlacklist = [];
    state.lastRotation = now;
    saveState(state);
  }
  
  // First pass: Try to find assets meeting our criteria that aren't blacklisted
  for (const market of enabledMarkets) {
    const denom = market.denom;
    
    // Skip if already trading this asset
    if (assetBlacklistSet.has(denom) && !CONFIG.IGNORE_BLACKLIST) continue;
    
    // Skip if we don't have price history
    if (!state.priceHistory[denom] || state.priceHistory[denom].length < CONFIG.PRICE_HISTORY_LENGTH) {
      if (CONFIG.DEBUG) console.log(chalk.gray(`Skipping ${denom}: insufficient price history`));
      continue;
    }
    
    // Calculate simple price change
    const priceChange = calculatePriceChange(state.priceHistory[denom]);
    
    if (CONFIG.DEBUG) {
      console.log(chalk.gray(`${denom} price change: ${(priceChange * 100).toFixed(4)}% (threshold: ${(CONFIG.MIN_PRICE_CHANGE * 100).toFixed(4)}%)`));
    }
    
    // Determine direction based on price change
    let direction;
    let forcedTrade = false;
    
    if (priceChange > CONFIG.MIN_PRICE_CHANGE) {
      direction = "long"; // Price went up, go long
    } else if (priceChange < -CONFIG.MIN_PRICE_CHANGE) {
      direction = "short"; // Price went down, go short
    } else if (CONFIG.FORCE_TRADE) {
      // For demo purposes, if price movement is small but we want to force trades,
      // use funding rate as a fallback signal
      forcedTrade = true;
      if (fundingRates[denom]) {
        direction = fundingRates[denom].fundingRate < 0 ? "long" : "short";
        if (CONFIG.DEBUG) console.log(chalk.gray(`Forcing trade for ${denom} based on funding rate: ${direction}`));
      } else {
        // If we don't have funding data, just pick a direction
        direction = Math.random() > 0.5 ? "long" : "short";
        if (CONFIG.DEBUG) console.log(chalk.gray(`Forcing random trade for ${denom}: ${direction}`));
      }
    } else {
      if (CONFIG.DEBUG) console.log(chalk.gray(`Skipping ${denom}: price change too small and FORCE_TRADE is off`));
      continue; // Skip if no clear direction and not forcing
    }
    
    // For demo, calculate strength as abs of price change + any funding edge
    let strength = forcedTrade ? 0.1 : Math.abs(priceChange);
    if (fundingRates[denom]) {
      // Add bonus strength if funding rate aligns with direction
      const fundingRate = fundingRates[denom].fundingRate;
      if ((direction === "long" && fundingRate < 0) || 
          (direction === "short" && fundingRate > 0)) {
        strength += Math.abs(fundingRate) / 100;
      }
    }
    
    opportunities.push({
      denom,
      direction,
      priceChange,
      strength,
      forcedTrade,
      latestPrice: state.priceHistory[denom][state.priceHistory[denom].length - 1].price
    });
  }
  
  // If we have no opportunities but FORCE_TRADE is on, try again ignoring the blacklist
  if (opportunities.length === 0 && CONFIG.FORCE_TRADE) {
    console.log(chalk.yellow("No opportunities found initially, trying to force a trade by ignoring blacklist"));
    
    // Just pick the first available market with price history
    for (const market of enabledMarkets) {
      const denom = market.denom;
      if (state.priceHistory[denom] && state.priceHistory[denom].length >= CONFIG.PRICE_HISTORY_LENGTH) {
        // Random direction for forced demo trade
        const direction = Math.random() > 0.5 ? "long" : "short";
        opportunities.push({
          denom,
          direction,
          priceChange: 0,
          strength: 0.1, // Low strength for forced trades
          forcedTrade: true,
          latestPrice: state.priceHistory[denom][state.priceHistory[denom].length - 1].price
        });
        console.log(chalk.yellow(`Forced trade opportunity created for ${denom} (${direction})`));
        break;
      }
    }
  }
  
  // Absolute last resort - if still no opportunities, clear the blacklist entirely and retry
  if (opportunities.length === 0 && CONFIG.FORCE_TRADE && state.assetBlacklist.length > 0) {
    console.log(chalk.yellow("Emergency: Clearing blacklist to find opportunities"));
    state.assetBlacklist = [];
    saveState(state);
    return findDemoOpportunities(state, enabledMarkets, fundingRates);
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
    return true;
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
    return true;
  }
  
  // Stop loss check
  if (totalPnlPercent <= -CONFIG.STOP_LOSS_PERCENT) {
    console.log(chalk.red(`Position ${positionId} hit stop loss: ${(totalPnlPercent * 100).toFixed(2)}%`));
    return true;
  }
  
  return false;
}

async function openRMMPosition(client, assets, attempt = 0) {
  if (CONFIG.DRY_RUN) {
    console.log(chalk.yellow(`[DRY RUN] Would open position with assets: ${JSON.stringify(assets)}`));
    return { dryRun: true };
  }
  
  try {
    const result = await openPosition(assets, CONFIG.LEVERAGE, CONFIG.COLLATERAL);
    console.log(chalk.green(`Position opened successfully`));
    return result;
  } catch (err) {
    if (err.message && err.message.includes("account sequence mismatch") && attempt < 2) {
      console.log(chalk.yellow("Sequence mismatch detected - refreshing client and retrying..."));
      await new Promise((resolve) => setTimeout(resolve, 10000)); // Wait 10 seconds
      const refreshedClient = await getClient();
      return await openRMMPosition(refreshedClient, assets, attempt + 1);
    }
    console.error(chalk.red(`Error opening position: ${err.message}`));
    throw err;
  }
}

async function closeRMMPosition(positionId) {
  if (CONFIG.DRY_RUN) {
    console.log(chalk.yellow(`[DRY RUN] Would close position ${positionId}`));
    return { dryRun: true, positionId };
  }
  
  try {
    const result = await closePosition(positionId);
    console.log(chalk.green(`Position ${positionId} closed successfully`));
    return result;
  } catch (err) {
    console.error(chalk.red(`Error closing position ${positionId}: ${err.message}`));
    throw err;
  }
}

// ---------- MAIN STRATEGY LOGIC ----------
async function managePositions(client, state, enabledMarkets) {
  // Get funding rates for additional signal
  const fundingRates = await getFundingRates();
  
  // 1. Get current open positions
  const openPositions = await getPositions();
  
  // 2. Check for positions to exit
  for (const position of openPositions) {
    const positionId = position.id;
    
    // Skip positions not managed by this strategy
    if (!state.positions[positionId]) continue;
    
    // Check if we should exit this position
    const shouldExit = await checkExitConditions(position, state);
    if (shouldExit) {
      try {
        const result = await closeRMMPosition(positionId);
        
        // Record the closed trade
        recordTrade(position, "close", result);
        
        // Remove from state
        delete state.positions[positionId];
        
        // Add assets to temporary blacklist to prevent immediate re-entry
        for (const asset of position.assets) {
          if (!state.assetBlacklist.includes(asset.denom)) {
            state.assetBlacklist.push(asset.denom);
          }
        }
        
        saveState(state);
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
  const opportunities = findDemoOpportunities(state, enabledMarkets, fundingRates);
  
  if (opportunities.length === 0) {
    console.log(chalk.blue("No opportunities found that meet criteria."));
    return;
  }
  
  console.log(chalk.blue(`Found ${opportunities.length} potential opportunities. Top opportunity:`));
  console.log(chalk.blue(JSON.stringify(opportunities[0], null, 2)));
  
  // 5. Open a new position with the best opportunity
  const availableSlots = CONFIG.MAX_POSITIONS - currentPositionCount;
  const opportunitiesToTake = opportunities.slice(0, availableSlots);
  
  for (const opportunity of opportunitiesToTake) {
    try {
      // For RMM, we can just use single asset trades or create complementary trades
      // For quick demo purposes, we'll do both - 50/50 split
      
      // Create complementary asset (for safety, not demo necessity)
      // Fix the logical error in complementary asset direction
      const complementaryAsset = {
        denom: opportunity.denom,
        long: !(opportunity.direction === "long"), // Correct way to negate the boolean condition
        percent: "0.5"
      };
      
      // For demo, we can also try to find a different asset pair
      let alternateAsset = null;
      for (const oppOpp of opportunities) {
        if (oppOpp.denom !== opportunity.denom) {
          alternateAsset = {
            denom: oppOpp.denom,
            long: oppOpp.direction === "long", // Same direction as the opportunity
            percent: "0.5"
          };
          break;
        }
      }
      
      // If we found an alternate asset, use it instead of complementary
      const secondAsset = alternateAsset || complementaryAsset;
      
      // Create the position assets
      const assets = [
        {
          denom: opportunity.denom,
          long: opportunity.direction === "long",
          percent: "0.5"
        },
        secondAsset
      ];
      
      console.log(chalk.blue(`Opening position with assets: ${JSON.stringify(assets)}`));
      
      // Open the position
      const result = await openRMMPosition(client, assets);
      
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
        // Store entry prices
        const entryPrices = {};
        
        for (const asset of assets) {
          if (state.priceHistory[asset.denom] && state.priceHistory[asset.denom].length > 0) {
            entryPrices[asset.denom] = state.priceHistory[asset.denom][state.priceHistory[asset.denom].length - 1].price;
          }
          
          // Add assets to blacklist to avoid trading them again immediately
          if (!state.assetBlacklist.includes(asset.denom)) {
            state.assetBlacklist.push(asset.denom);
          }
        }
        
        // Save to state
        if (CONFIG.DRY_RUN) {
          positionId = `dry-run-${Date.now()}`;
        }
        
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
        }, "open", result);
        
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
    console.log(chalk.blue("Starting RMM Demo Strategy"));
    
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
    
    console.log(chalk.green("RMM Demo Strategy run completed"));
  } catch (error) {
    console.error(chalk.red(`Fatal error: ${error.message}`));
  }
}

// Run the strategy
main().catch(console.error); 