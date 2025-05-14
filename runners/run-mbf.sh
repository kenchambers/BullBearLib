#!/bin/bash

# Momentum Breakout Follower (MBF) Strategy Runner
# Usage: 
#   ./run-mbf.sh              # Default 30-min cadence
#   INTERVAL=900 ./run-mbf.sh # Custom 15-min interval

# Default interval is 30 minutes (1800 seconds)
INTERVAL=${INTERVAL:-1800}

# Change to the root directory to ensure access to .env and lib files
cd $(dirname $0)/..
ROOT_DIR=$(pwd)

echo "🔄 Starting Momentum Breakout Follower Strategy Runner (interval: ${INTERVAL}s)"
echo "📊 Press Ctrl+C to stop"
echo "📝 Started at: $(date)"

# Create log directory
LOG_DIR="$ROOT_DIR/logs"
mkdir -p $LOG_DIR
LOG_FILE="$LOG_DIR/mbf-$(date +%Y%m%d).log"

echo "📋 Logging to: $LOG_FILE"

# Ensure we have proper cache directory access
mkdir -p $ROOT_DIR/cache

# Function to run MBF strategy script with logs
run_mbf_strategy() {
  echo "🚀 Running MBF Strategy at $(date)" | tee -a "$LOG_FILE"
  echo "-------------------------------------" | tee -a "$LOG_FILE"
  node $ROOT_DIR/strategies/momentum-breakout-follower.js 2>&1 | tee -a "$LOG_FILE"
  local status=$?
  echo "-------------------------------------" | tee -a "$LOG_FILE"
  echo "Completed with status: $status at $(date)" | tee -a "$LOG_FILE"
  echo "" | tee -a "$LOG_FILE"
  return $status
}

# Run continuously until interrupted
while true; do
  run_mbf_strategy
  sleep ${INTERVAL}
done 