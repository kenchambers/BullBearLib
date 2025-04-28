require("dotenv").config();
const chalk = require("chalk");
const fs = require("fs");
const { getClient, getPositions, getBalance, getMarkets, getPrices, getMaxLeverages, getFundingRates, openPosition, closePosition } = require("./lib");

var client;

async function main() {
  client = await getClient();

  console.log("Using Address:", client.myAddress);

  const currentOpenPositions = await getPositions();
  console.log("Current Open Position Count:", currentOpenPositions.length);
  console.log("Current Open Positions:", JSON.stringify(currentOpenPositions[0], null, 2));

  const currentBalance = await getBalance();
  console.log(chalk.green("Current USDC Balance:", currentBalance));

  const markets = await getMarkets();
  console.log("Markets:", markets);

  const prices = await getPrices();
  console.log("Prices:", prices);

  const maxLeverages = await getMaxLeverages();
  console.log("Max Leverages:", maxLeverages);

  const fundingRates = await getFundingRates();
  console.log("Funding Rates:", fundingRates);

  //Example to open a LONG BTC, Short ETH with 3x leverage, and $10 as collateral.
  /*
  const openResult = await openPosition(
    [
      { denom: "perps/ubtc", long: true, percent: "0.5" },
      { denom: "perps/ueth", long: false, percent: "0.5" },
    ],
    "3", //4x leverage
    10 //10 collateral
  );
  console.log("Open Result:", openResult);
*/
  //Close a position given the position id:
  /*
  const closeResult = await closePosition(6477);
  console.log("Close Result:", closeResult);
  */

  //Build here!
}

main();
