require("dotenv").config();
const chalk = require("chalk");
const fs = require("fs");
const path = require("path");
const { GasPrice } = require("@cosmjs/stargate");
const { DirectSecp256k1HdWallet } = require("@cosmjs/proto-signing");
const { SigningCosmWasmClient } = require("@cosmjs/cosmwasm-stargate");
const { USDC_DENOM, OVERRIDE_RPC, BVBCONTRACT, MARKET_CACHE_TIME, PRICE_CACHE_TIME, MAX_LEVERAGE_CACHE_TIME, FUNDING_RATE_CACHE_TIME, CACHE_DIR, MARS } = require("./consts");
const SEED = process.env.SEED;
const { chains } = require("chain-registry");

const chain = chains.find((chain) => chain.chain_name === "neutron");
const DIVISOR = 1_000_000;

var client;

async function getClient(seedOverride = null) {
  var useSeed = seedOverride || SEED;
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(useSeed, {
    prefix: "neutron",
  });
  const [{ address }] = await wallet.getAccounts();
  const gasPrice = GasPrice.fromString(`0.0065${USDC_DENOM}`);
  const options = { gasPrice };
  var useRPC;

  if (OVERRIDE_RPC) {
    useRPC = OVERRIDE_RPC;
  } else {
    useRPC = chain.apis.rpc[Math.floor(Math.random() * chain.apis.rpc.length)].address;
  }
  console.log(chalk.blue("Using RPC:", useRPC));
  const signingClient = await SigningCosmWasmClient.connectWithSigner(useRPC, wallet, options);

  client = { wallet, signingClient, myAddress: address };
  return client;
}

async function getPositions(address = null) {
  /*Returns an array of position objects that look like below:
  [
    {
      "id": 1234,
      "user": "neutron1...",
      "credit_account_id": "4567",
      "assets": [
        {
          "denom": "perps/ubtc",
          "long": true,
          "size": "0.0009",
          "collateral_percent": "0.5",
          "exec_price": "84800",
          "leverage": "3"
        },
         {
          "denom": "perps/ueth",
          "long": false,
          "size": "-1",
          "collateral_percent": "0.5",
          "exec_price": "1800.53",
          "leverage": "3"
        }
      ],
      "collateral_amount": "10000000",
      "leverage": "3",
      "created_at": "1745516650526230395",
      "position_type": "Classic",
      "cluster_id": null,
      "cluster_name": null
    }
  ]
  */
  try {
    const positions = await client.signingClient.queryContractSmart(BVBCONTRACT, {
      user_positions_new: { user: address || client.myAddress, position_type: "Classic" },
    });
    return positions;
  } catch (err) {
    console.error(chalk.red("Error getting positions:", err.message));
    return [];
  }
}

async function getBalance(denom = USDC_DENOM) {
  //Returns the balance of the user in the specified denom, defaults to usdc.
  try {
    const balance = await client.signingClient.getBalance(client.myAddress, denom);
    return balance.amount / DIVISOR || 0;
  } catch (err) {
    console.error(chalk.red("Error getting balance:", err.message));
    return 0;
  }
}

async function tryCache(cachePath, cacheTime, fetchDataFn) {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR);
      console.log("Created cache directory");
    }

    if (fs.existsSync(cachePath)) {
      const cachedData = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      const now = Date.now();

      if (cachedData.lastUpdated && now - cachedData.lastUpdated < cacheTime) {
        return { fromCache: true, data: cachedData.data };
      }
    }

    const freshData = await fetchDataFn();
    const cacheData = {
      lastUpdated: Date.now(),
      data: freshData,
    };
    fs.writeFileSync(cachePath, JSON.stringify(cacheData, null, 2));

    return { fromCache: false, data: freshData };
  } catch (err) {
    if (fs.existsSync(cachePath)) {
      try {
        const cachedData = JSON.parse(fs.readFileSync(cachePath, "utf8"));
        console.log(chalk.red(`Returning expired cached data from ${cachePath} due to fetch error`));
        return { fromCache: true, expired: true, data: cachedData.data };
      } catch (cacheErr) {
        console.log(`Error reading cache from ${cachePath}:`, cacheErr);
      }
    }
    return { fromCache: false, error: true, data: null };
  }
}

async function getMarkets() {
  //Gets all available markets enabled on BullBear. Returns an array of objects, containing the denom and the display. [{denom:"perps/ubtc",display:"BTC"}]
  const marketCachePath = path.join(CACHE_DIR, "markets.json");

  const fetchMarkets = async () => {
    const markets = await client.signingClient.queryContractSmart(BVBCONTRACT, {
      markets: {},
    });
    return markets
      .filter((market) => market.enabled)
      .map((market) => ({
        denom: market.denom,
        display: market.display,
      }));
  };

  const result = await tryCache(marketCachePath, MARKET_CACHE_TIME, fetchMarkets);
  return result.data || [];
}

async function getMaxLeverages() {
  //Gets the max leverages for all available markets. Returns an object like: {"perps/ubtc":10, "perps/ueth":10}
  const maxLeverageCachePath = path.join(CACHE_DIR, "leverages.json");

  const fetchMaxLeverages = async () => {
    const maxLeverages = await client.signingClient.queryContractSmart(BVBCONTRACT, {
      max_leverages: {},
    });
    return maxLeverages;
  };

  const result = await tryCache(maxLeverageCachePath, MAX_LEVERAGE_CACHE_TIME, fetchMaxLeverages);
  return result.data || [];
}

async function getFundingRates() {
  /*Gets the funding rates for all markets. Returns an object like: 
    Funding Rates: {
      'perps/uakt': {
        fundingRate: 13.69071489640399,
        longOI: '3969947062',
        shortOI: '6066533265'
      },
      'perps/uarb': {
        fundingRate: 32.59113048323023,
        longOI: '129937160',
        shortOI: '24324580'
      }
    }
    Funding rates are a yearly percentage.
    If it is POSITIVE, long positions pay short positions this rate.
    If it is negative, short positions pay long positions this rate.
  */
  const fundingRateCache = path.join(CACHE_DIR, "rates.json");

  const fetchFundingRates = async () => {
    const rates = await client.signingClient.queryContractSmart(MARS.PERPS, {
      markets: {
        limit: 50,
      },
    });

    const fundingData = {};
    for (const rate of rates.data) {
      fundingData[rate.denom] = {
        fundingRate: parseFloat(rate.current_funding_rate || 0) * 365 * 100,
        longOI: rate.long_oi_value,
        shortOI: rate.short_oi_value,
      };
    }

    return fundingData;
  };

  const result = await tryCache(fundingRateCache, FUNDING_RATE_CACHE_TIME, fetchFundingRates);
  return result.data || [];
}

async function getPrices() {
  //Returns all price data for all available markets. Returns an object like: {"perps/ubtc":"93500.50", "perps/ueth":"1850.23"}
  const priceCachePath = path.join(CACHE_DIR, "prices.json");

  const fetchPrices = async () => {
    const markets = await getMarkets();
    const allDenoms = markets.map((market) => market.denom);
    return await client.signingClient.queryContractSmart(MARS.ORACLE, {
      prices_by_denoms: { denoms: allDenoms },
    });
  };

  const result = await tryCache(priceCachePath, PRICE_CACHE_TIME, fetchPrices);
  return result.data || {};
}

async function openPosition(assets, leverage, collateral) {
  try {
    const msg = {
      open_position: {
        position_input: {
          Classic: {
            assets: assets,
            leverage: leverage.toString(),
          },
        },
      },
    };

    const funds = [{ denom: USDC_DENOM, amount: (collateral * DIVISOR).toString() }];
    const result = await client.signingClient.execute(client.myAddress, BVBCONTRACT, msg, "auto", "BullBear.Zone Position Opened", funds);
    console.log(chalk.green("Position Opened: ", JSON.stringify(assets), "with", leverage, "x leverage and", collateral, "USDC collateral"));
    return result;
  } catch (error) {
    console.error(chalk.red("Error opening position:", error.message));
    return null;
  }
}

async function closePosition(positionId) {
  try {
    const msg = {
      close: { position_id: positionId },
    };
    const result = await client.signingClient.execute(client.myAddress, BVBCONTRACT, msg, "auto", "BullBear.Zone Position Closed");
    console.log(chalk.green("Position Closed: ", positionId));
    return result;
  } catch (err) {
    console.error(chalk.red("Error closing position:", err.message));
    return null;
  }
}

module.exports = {
  getClient,
  getPositions,
  getBalance,
  getMarkets,
  getPrices,
  getMaxLeverages,
  openPosition,
  closePosition,
  getFundingRates,
};
