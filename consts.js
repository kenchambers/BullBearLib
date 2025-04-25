module.exports = {
  OVERRIDE_RPC: "https://rpc-lb.neutron.org", //If set this rpc will be used, otherwise one will automatically be selected from the registry
  USDC_DENOM: "ibc/B559A80D62249C8AA07A380E2A2BEA6E5CA9A6F079C912C3A9E9B494105E4F81",
  BVBCONTRACT: "neutron17v2cwmaynxhc004uph4rle45feepg0z86wwxkue2kc0t5hx82f2s6gmu73",
  MARS: {
    ORACLE: "neutron1dwp6m7pdrz6rnhdyrx5ha0acsduydqcpzkylvfgspsz60pj2agxqaqrr7g",
    CREDIT_MANAGER: "neutron1qdzn3l4kn7gsjna2tfpg3g3mwd6kunx4p50lfya59k02846xas6qslgs3r",
    PERPS: "neutron1g3catxyv0fk8zzsra2mjc0v4s69a7xygdjt85t54l7ym3gv0un4q2xhaf6",
  },
  MARS_OPEN_FEE_PERCENT: 0.00075,
  MARS_CLOSE_FEE_PERCENT: 0.00075,
  CACHE_DIR: "./cache",
  PRICE_CACHE_TIME: 1000 * 30, //30s. Allows us to constantly fetch the price and re-fetch/save if needed
  MARKET_CACHE_TIME: 1000 * 60 * 60 * 1, //1h. No need to re-fetch markets each time
  MAX_LEVERAGE_CACHE_TIME: 1000 * 60 * 60 * 48, //48h. Basically never change.
  FUNDING_RATE_CACHE_TIME: 1000 * 60 * 5, //5 mins
};
