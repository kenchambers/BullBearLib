require("dotenv").config();
const chalk = require("chalk");
const fs = require("fs");
const { getClient, getPositions, getBalance, getMarkets, getPrices } = require("./lib");

var client;

async function main() {
  client = await getClient();

  console.log("Using Address:", client.myAddress);

  const currentOpenPositions = await getPositions();
  console.log("Current Open Position Count:", currentOpenPositions.length);

  const currentBalance = await getBalance();
  console.log(chalk.green("Current USDC Balance:", currentBalance));

  const markets = await getMarkets();
  console.log("Markets:", markets);

  const prices = await getPrices();
  console.log("Prices:", prices);

  //Build here!
}

main();
