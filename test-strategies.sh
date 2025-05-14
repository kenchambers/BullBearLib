#!/bin/bash

# Change to script's directory to ensure we're in the right place
cd "$(dirname "$0")"
ROOT_DIR=$(pwd)

echo "BullBearLib Strategy Test Script"
echo "--------------------------------"
echo "This script verifies that all strategies load correctly with the new organization."
echo "Root directory: $ROOT_DIR"
echo

# Create a temporary test directory
TEST_DIR="$ROOT_DIR/test-output"
mkdir -p $TEST_DIR

# Function to test if a strategy loads correctly
test_strategy() {
  local strategy_file=$1
  local strategy_name=$2
  
  echo "Testing $strategy_name..."
  node -e "try { require('$ROOT_DIR/$strategy_file'); console.log('  ✅ Successfully loaded'); } catch (err) { console.error('  ❌ Error loading: ' + err.message); process.exit(1); }" > "$TEST_DIR/$strategy_name.log" 2>&1
  
  if [ $? -eq 0 ]; then
    echo "  ✅ $strategy_name loaded successfully"
    return 0
  else
    echo "  ❌ $strategy_name failed to load"
    echo "  Error: $(cat $TEST_DIR/$strategy_name.log)"
    return 1
  fi
}

# Test all strategies
echo "Testing strategies..."
echo

failures=0

test_strategy "strategies/funding-rate-arbitrage.js" "Funding Rate Arbitrage" || ((failures++))
test_strategy "strategies/momentum-breakout-follower.js" "Momentum Breakout Follower" || ((failures++))
test_strategy "strategies/yield-harvester.js" "Yield Harvester" || ((failures++))
test_strategy "strategies/volatility-breakout-hunter.js" "Volatility Breakout Hunter" || ((failures++))
test_strategy "strategies/funding-skew-reversal.js" "Funding Skew Reversal" || ((failures++))

echo
if [ $failures -eq 0 ]; then
  echo "✅ All strategies loaded successfully!"
else
  echo "❌ $failures strategies failed to load. Check the logs in $TEST_DIR for details."
fi

echo
echo "Tests complete." 