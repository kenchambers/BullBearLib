require("dotenv").config();
const chalk = require("chalk");
const fs = require("fs");
const path = require("path");
const {
  getClient,
  getPositions,
  getBalance,
  getMarkets,
  getPrices,
  getMaxLeverages,
  getFundingRates,
  openPosition,
  closePosition,
} = require("../lib");
const { CACHE_DIR, USDC_DENOM } = require("../consts");

// Strategy Configuration
const CONFIG = {
  STRATEGY_NAME: "Liquidity Imbalance Tracker (LIT)",
  VERSION: "1.0.0",
  COLLATERAL: 10.1, // Slightly above $10 min to cover gas fees
  BASE_LEVERAGE: 2.5, // Conservative default leverage
  MAX_POSITIONS: 3, // Maximum number of concurrent positions
  MIN_FUNDING_RATE_THRESHOLD: 15, // Annual percentage threshold for funding rate imbalance
  MIN_OI_RATIO_THRESHOLD: 2.0, // Minimum ratio of long:short or short:long OI to consider imbalanced
  PROFIT_TARGET: 0.03, // 3% profit target
  STOP_LOSS: 0.04, // 4% stop loss
  MAX_HOLD_TIME: 1000 * 60 * 60 * 24, // 24 hours maximum hold time
  BLACKLIST_TIME: 1000 * 60 * 60 * 6, // 6 hours to blacklist problematic assets
  RETRY_DELAY: 20000, // 20 seconds between retry attempts
  RETRY_MAX_ATTEMPTS: 3, // Maximum number of retry attempts
  MIN_USDC_BALANCE: 15, // Minimum USDC balance to maintain
};

// State management
const STATE_FILE = path.join(CACHE_DIR, "lit-state.json");
const BLACKLIST_FILE = path.join(CACHE_DIR, "lit-blacklist.json");

// Initialize client
var client;

// Helper function to load state
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      console.log(chalk.blue("Loaded state:", JSON.stringify(state, null, 2)));
      return state;
    }
  } catch (err) {
    console.error(chalk.red("Error loading state:", err.message));
  }
  return { positions: [], lastRun: 0 };
}

// Helper function to save state
function saveState(state) {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR);
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    console.log(chalk.blue("State saved"));
  } catch (err) {
    console.error(chalk.red("Error saving state:", err.message));
  }
}

// Helper function to load blacklist
function loadBlacklist() {
  try {
    if (fs.existsSync(BLACKLIST_FILE)) {
      const blacklist = JSON.parse(fs.readFileSync(BLACKLIST_FILE, "utf8"));
      // Clean up expired blacklist entries
      const now = Date.now();
      Object.keys(blacklist).forEach((denom) => {
        if (blacklist[denom].until < now) {
          delete blacklist[denom];
        }
      });
      fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(blacklist, null, 2));
      return blacklist;
    }
  } catch (err) {
    console.error(chalk.red("Error loading blacklist:", err.message));
  }
  return {};
}

// Helper function to blacklist an asset
function blacklistAsset(denom, reason) {
  try {
    const blacklist = loadBlacklist();
    blacklist[denom] = {
      reason,
      timestamp: Date.now(),
      until: Date.now() + CONFIG.BLACKLIST_TIME,
    };
    fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(blacklist, null, 2));
    console.log(
      chalk.yellow(
        `Blacklisted ${denom} for ${
          CONFIG.BLACKLIST_TIME / 1000 / 60 / 60
        } hours. Reason: ${reason}`
      )
    );
  } catch (err) {
    console.error(chalk.red("Error blacklisting asset:", err.message));
  }
}

// Helper function to calculate OI imbalance ratio
function calculateOIImbalance(longOI, shortOI) {
  // Convert string values to numbers
  const longValue = parseFloat(longOI);
  const shortValue = parseFloat(shortOI);

  if (longValue > shortValue) {
    return longValue / shortValue;
  } else {
    return shortValue / longValue;
  }
}

// Helper function to determine position side based on imbalance
function determineSide(longOI, shortOI, fundingRate) {
  // Convert string values to numbers
  const longValue = parseFloat(longOI);
  const shortValue = parseFloat(shortOI);

  // Position against the crowd: if more longs, we go short (and vice versa)
  // Unless funding rate suggests otherwise (very negative funding means shorts are paying longs)
  if (
    longValue > shortValue &&
    fundingRate > -CONFIG.MIN_FUNDING_RATE_THRESHOLD
  ) {
    return false; // Short
  } else if (
    shortValue > longValue &&
    fundingRate < CONFIG.MIN_FUNDING_RATE_THRESHOLD
  ) {
    return true; // Long
  } else if (fundingRate > CONFIG.MIN_FUNDING_RATE_THRESHOLD) {
    return false; // Short when funding rate is very positive (longs pay shorts)
  } else if (fundingRate < -CONFIG.MIN_FUNDING_RATE_THRESHOLD) {
    return true; // Long when funding rate is very negative (shorts pay longs)
  }

  // Default fallback - no strong signal
  return null;
}

// Helper function to adjust leverage based on imbalance severity
function calculateDynamicLeverage(imbalanceRatio, fundingRate, maxLeverage) {
  let leverage = CONFIG.BASE_LEVERAGE;

  // Increase leverage for stronger signals
  if (imbalanceRatio > 3 || Math.abs(fundingRate) > 25) {
    leverage = CONFIG.BASE_LEVERAGE * 1.2;
  }
  if (imbalanceRatio > 5 || Math.abs(fundingRate) > 40) {
    leverage = CONFIG.BASE_LEVERAGE * 1.5;
  }

  // Never exceed max leverage
  return Math.min(leverage, maxLeverage, 5).toFixed(1); // Cap at 5x for safety
}

// Main function to check positions and manage exits
async function checkExistingPositions() {
  console.log(chalk.blue("Checking existing positions..."));

  const state = loadState();
  const currentPositions = await getPositions();
  const prices = await getPrices();

  let updatedPositions = [];
  let positionsChanged = false;

  for (const statePosition of state.positions) {
    // Find matching on-chain position
    const onChainPosition = currentPositions.find(
      (p) => p.id === statePosition.id
    );

    if (!onChainPosition) {
      console.log(
        chalk.yellow(
          `Position ${statePosition.id} no longer exists on-chain, removing from state`
        )
      );
      positionsChanged = true;
      continue;
    }

    // Check if position should be closed based on criteria
    const now = Date.now();
    const holdTime = now - statePosition.openedAt;
    let shouldClose = false;
    let closeReason = "";

    // Get current price
    const denom = statePosition.assets[0].denom;
    const currentPrice = parseFloat(prices[denom]);
    const openPrice = parseFloat(statePosition.entryPrice);

    if (!currentPrice) {
      console.log(
        chalk.yellow(
          `Could not get current price for ${denom}, skipping evaluation`
        )
      );
      updatedPositions.push(statePosition);
      continue;
    }

    // Calculate profit/loss percentage
    let pnl = 0;
    if (statePosition.isLong) {
      pnl = (currentPrice - openPrice) / openPrice;
    } else {
      pnl = (openPrice - currentPrice) / openPrice;
    }

    // Check exit criteria
    if (pnl >= CONFIG.PROFIT_TARGET) {
      shouldClose = true;
      closeReason = `Profit target reached: ${(pnl * 100).toFixed(2)}%`;
    } else if (pnl <= -CONFIG.STOP_LOSS) {
      shouldClose = true;
      closeReason = `Stop loss triggered: ${(pnl * 100).toFixed(2)}%`;
    } else if (holdTime >= CONFIG.MAX_HOLD_TIME) {
      shouldClose = true;
      closeReason = `Maximum hold time reached: ${(
        holdTime /
        1000 /
        60 /
        60
      ).toFixed(1)} hours`;
    }

    // Close position if needed
    if (shouldClose) {
      console.log(
        chalk.green(`Closing position ${statePosition.id}: ${closeReason}`)
      );

      // Attempt to close with retries
      let closeResult = null;
      let attempts = 0;

      while (!closeResult && attempts < CONFIG.RETRY_MAX_ATTEMPTS) {
        attempts++;
        closeResult = await closePosition(statePosition.id);

        if (!closeResult) {
          console.log(
            chalk.yellow(
              `Close attempt ${attempts} failed, retrying in ${
                CONFIG.RETRY_DELAY / 1000
              }s...`
            )
          );
          await new Promise((resolve) =>
            setTimeout(resolve, CONFIG.RETRY_DELAY)
          );
        }
      }

      if (closeResult) {
        console.log(
          chalk.green(
            `Successfully closed position ${statePosition.id} with reason: ${closeReason}`
          )
        );
        positionsChanged = true;

        // If closed due to error, blacklist the asset temporarily
        if (closeReason.includes("error")) {
          blacklistAsset(denom, closeReason);
        }
      } else {
        console.log(
          chalk.red(
            `Failed to close position ${statePosition.id} after ${attempts} attempts`
          )
        );
        updatedPositions.push(statePosition);
      }
    } else {
      // Position still valid, keep in state
      updatedPositions.push(statePosition);
      console.log(
        chalk.blue(
          `Position ${statePosition.id}: Current PnL: ${(pnl * 100).toFixed(
            2
          )}%, Hold time: ${(holdTime / 1000 / 60 / 60).toFixed(1)} hours`
        )
      );
    }
  }

  // Update state if positions changed
  if (positionsChanged) {
    state.positions = updatedPositions;
    saveState(state);
  }

  return updatedPositions.length;
}

// Find best opportunities based on liquidity imbalance
async function findImbalanceOpportunities() {
  console.log(chalk.blue("Finding liquidity imbalance opportunities..."));

  const fundingRates = await getFundingRates();
  const markets = await getMarkets();
  const maxLeverages = await getMaxLeverages();
  const prices = await getPrices();
  const blacklist = loadBlacklist();

  // Create opportunity scores
  const opportunities = [];

  for (const market of markets) {
    const denom = market.denom;
    const display = market.display;

    // Skip blacklisted assets
    if (blacklist[denom]) {
      console.log(
        chalk.yellow(`Skipping blacklisted asset: ${display} (${denom})`)
      );
      continue;
    }

    // Check if we have funding and price data
    if (!fundingRates[denom] || !prices[denom]) {
      console.log(chalk.yellow(`Missing data for ${display}, skipping`));
      continue;
    }

    const fundingRate = fundingRates[denom].fundingRate;
    const longOI = fundingRates[denom].longOI;
    const shortOI = fundingRates[denom].shortOI;
    const maxLeverage = maxLeverages[denom] || CONFIG.BASE_LEVERAGE;

    // Calculate imbalance ratio (how skewed is open interest)
    const imbalanceRatio = calculateOIImbalance(longOI, shortOI);

    // Determine position side based on imbalance
    const positionSide = determineSide(longOI, shortOI, fundingRate);

    // Only consider opportunities with clear signals
    if (
      positionSide !== null &&
      imbalanceRatio >= CONFIG.MIN_OI_RATIO_THRESHOLD
    ) {
      // Calculate score based on imbalance and funding rate
      let score = imbalanceRatio;
      if (Math.abs(fundingRate) > CONFIG.MIN_FUNDING_RATE_THRESHOLD) {
        score += Math.abs(fundingRate) / 10;
      }

      // Calculate leverage based on signal strength
      const leverage = calculateDynamicLeverage(
        imbalanceRatio,
        fundingRate,
        maxLeverage
      );

      opportunities.push({
        denom,
        display,
        score,
        isLong: positionSide,
        imbalanceRatio,
        fundingRate,
        leverage,
        price: prices[denom],
      });
    }
  }

  // Sort by score (highest first)
  opportunities.sort((a, b) => b.score - a.score);

  // Log top opportunities
  console.log(chalk.cyan("Top liquidity imbalance opportunities:"));
  for (let i = 0; i < Math.min(opportunities.length, 5); i++) {
    const opp = opportunities[i];
    console.log(
      chalk.cyan(
        `${i + 1}. ${opp.display}: Score: ${opp.score.toFixed(2)}, Side: ${
          opp.isLong ? "LONG" : "SHORT"
        }, Imbalance: ${opp.imbalanceRatio.toFixed(
          2
        )}, Funding: ${opp.fundingRate.toFixed(2)}%`
      )
    );
  }

  return opportunities;
}

// Open new position based on opportunity
async function openNewPosition(opportunity) {
  console.log(
    chalk.green(
      `Opening new position for ${opportunity.display} (${
        opportunity.isLong ? "LONG" : "SHORT"
      })`
    )
  );

  const assets = [
    {
      denom: opportunity.denom,
      long: opportunity.isLong,
      percent: "1.0",
    },
  ];

  // Attempt to open position with retries
  let openResult = null;
  let attempts = 0;

  while (!openResult && attempts < CONFIG.RETRY_MAX_ATTEMPTS) {
    attempts++;

    // Add delay between retries
    if (attempts > 1) {
      console.log(
        chalk.yellow(
          `Waiting ${CONFIG.RETRY_DELAY / 1000}s before retry ${attempts}...`
        )
      );
      await new Promise((resolve) => setTimeout(resolve, CONFIG.RETRY_DELAY));
    }

    openResult = await openPosition(
      assets,
      opportunity.leverage,
      CONFIG.COLLATERAL
    );

    if (!openResult) {
      console.log(chalk.yellow(`Open attempt ${attempts} failed`));
    }
  }

  if (!openResult) {
    console.log(
      chalk.red(
        `Failed to open position after ${attempts} attempts, blacklisting asset`
      )
    );
    blacklistAsset(
      opportunity.denom,
      "Failed to open position after multiple attempts"
    );
    return null;
  }

  // Extract position ID from the events in the result
  let positionId = null;
  try {
    // This is an approximate way to get the ID - might need adjusting based on actual return format
    const events = openResult.events || [];
    for (const event of events) {
      if (event.type === "wasm") {
        const attributes = event.attributes || [];
        for (const attr of attributes) {
          if (attr.key === "position_id") {
            positionId = parseInt(attr.value);
            break;
          }
        }
      }
      if (positionId) break;
    }
  } catch (err) {
    console.error(chalk.red("Error extracting position ID:", err.message));
  }

  // If we couldn't get position ID, check on-chain positions
  if (!positionId) {
    console.log(
      chalk.yellow(
        "Could not extract position ID from result, checking on-chain positions"
      )
    );
    const positions = await getPositions();
    if (positions.length > 0) {
      // Get the most recent position
      const latestPosition = positions.sort(
        (a, b) => parseInt(b.id) - parseInt(a.id)
      )[0];
      positionId = parseInt(latestPosition.id);
      console.log(chalk.blue(`Found latest position ID: ${positionId}`));
    }
  }

  if (!positionId) {
    console.log(
      chalk.red("Could not determine position ID, cannot track position")
    );
    return null;
  }

  // Update state with new position
  const state = loadState();
  state.positions.push({
    id: positionId,
    denom: opportunity.denom,
    display: opportunity.display,
    isLong: opportunity.isLong,
    leverage: opportunity.leverage,
    entryPrice: opportunity.price,
    collateral: CONFIG.COLLATERAL,
    openedAt: Date.now(),
    assets: assets,
  });
  saveState(state);

  console.log(
    chalk.green(
      `Successfully opened position ${positionId} for ${opportunity.display}`
    )
  );
  return positionId;
}

// Main strategy execution
async function executeStrategy() {
  try {
    console.log(chalk.cyan("========================================"));
    console.log(
      chalk.cyan(`Executing ${CONFIG.STRATEGY_NAME} v${CONFIG.VERSION}`)
    );
    console.log(chalk.cyan("========================================"));

    // Connect to client
    client = await getClient();
    console.log(chalk.blue("Connected to client, address:", client.myAddress));

    // Check USDC balance
    const balance = await getBalance();
    console.log(chalk.green(`Current USDC balance: ${balance}`));

    if (balance < CONFIG.MIN_USDC_BALANCE) {
      console.log(
        chalk.red(
          `Insufficient USDC balance (${balance}), minimum required: ${CONFIG.MIN_USDC_BALANCE}`
        )
      );
      return;
    }

    // Check and manage existing positions
    const activePositionCount = await checkExistingPositions();
    console.log(
      chalk.blue(`Currently tracking ${activePositionCount} active positions`)
    );

    // Find new opportunities if we have room for more positions
    if (activePositionCount < CONFIG.MAX_POSITIONS) {
      const opportunities = await findImbalanceOpportunities();

      if (opportunities.length === 0) {
        console.log(chalk.yellow("No suitable opportunities found"));
        return;
      }

      // Open position with the best opportunity
      const bestOpportunity = opportunities[0];
      console.log(
        chalk.green(
          `Selected opportunity: ${bestOpportunity.display} (${
            bestOpportunity.isLong ? "LONG" : "SHORT"
          })`
        )
      );
      console.log(
        chalk.green(
          `Imbalance ratio: ${bestOpportunity.imbalanceRatio.toFixed(
            2
          )}, Funding rate: ${bestOpportunity.fundingRate.toFixed(2)}%`
        )
      );

      await openNewPosition(bestOpportunity);
    } else {
      console.log(
        chalk.yellow(
          `Maximum positions (${CONFIG.MAX_POSITIONS}) already reached, not opening new positions`
        )
      );
    }

    // Update last run timestamp
    const state = loadState();
    state.lastRun = Date.now();
    saveState(state);

    console.log(chalk.cyan("Strategy execution completed successfully"));
  } catch (err) {
    console.error(chalk.red("Error executing strategy:", err.message));
  }
}

// Run the strategy
(async () => {
  await executeStrategy();
})();

// Export for testing
module.exports = {
  executeStrategy,
  findImbalanceOpportunities,
  checkExistingPositions,
  CONFIG,
};
