require("dotenv").config();
const chalk = require("chalk");
const fs = require("fs");
const path = require("path");
const { GasPrice } = require("@cosmjs/stargate");
const { DirectSecp256k1HdWallet } = require("@cosmjs/proto-signing");
const { SigningCosmWasmClient } = require("@cosmjs/cosmwasm-stargate");
const { USDC_DENOM, OVERRIDE_RPC, BVBCONTRACT, MARKET_CACHE_TIME, PRICE_CACHE_TIME, CACHE_DIR, MARS } = require("./consts");
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
  const positions = await client.signingClient.queryContractSmart(BVBCONTRACT, {
    user_positions_new: { user: address || client.myAddress, position_type: "Classic" },
  });
  return positions;
}

async function getBalance(denom = USDC_DENOM) {
  const balance = await client.signingClient.getBalance(client.myAddress, denom);
  return balance.amount / DIVISOR || 0;
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

module.exports = {
  getClient,
  getPositions,
  getBalance,
  getMarkets,
  getPrices,
};
