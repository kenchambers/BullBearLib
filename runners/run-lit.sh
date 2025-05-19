#!/bin/bash

# Liquidity Imbalance Tracker (LIT) Strategy Runner
# ==================================================
# This script runs the LIT strategy at specified intervals

# Get the directory of the script
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd $DIR/..

# Default interval is 30 minutes
INTERVAL=${INTERVAL:-1800}
STRATEGY_NAME="Liquidity Imbalance Tracker"

# Function to execute the strategy
run_strategy() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') - Running $STRATEGY_NAME strategy"
  node strategies/liquidity-imbalance-tracker.js
  
  # Check if the last run was successful
  if [ $? -eq 0 ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $STRATEGY_NAME strategy completed successfully"
  else
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $STRATEGY_NAME strategy failed with error code $?"
  fi
}

# Function to handle process termination
cleanup() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') - Stopping $STRATEGY_NAME strategy runner"
  exit 0
}

# Register the cleanup function for termination signals
trap cleanup SIGINT SIGTERM

# Print startup message
echo "$(date '+%Y-%m-%d %H:%M:%S') - Starting $STRATEGY_NAME strategy runner"
echo "$(date '+%Y-%m-%d %H:%M:%S') - Running at ${INTERVAL} second intervals"
echo "$(date '+%Y-%m-%d %H:%M:%S') - Press Ctrl+C to stop"

# Run the strategy immediately on startup
run_strategy

# Main loop to run the strategy at specified intervals
while true; do
  echo "$(date '+%Y-%m-%d %H:%M:%S') - Waiting ${INTERVAL} seconds until next execution..."
  sleep $INTERVAL
  run_strategy
done 