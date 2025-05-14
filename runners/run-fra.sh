#!/bin/bash
# Funding Rate Arbitrage (FRA) Strategy Runner
# Usage: 
#   ./run-fra.sh              # Default 30-min cadence
#   INTERVAL=900 ./run-fra.sh # Custom 15-min interval

# Default interval is 30 minutes (1800 seconds)
INTERVAL=${INTERVAL:-1800}

# Change to the root directory to ensure access to .env and lib files
cd $(dirname $0)/..
ROOT_DIR=$(pwd)

echo "🔄 Starting Funding Rate Arbitrage Strategy Runner (interval: ${INTERVAL}s)"
echo "📊 Press Ctrl+C to stop"
echo "📝 Started at: $(date)"

# Create log directory
LOG_DIR="$ROOT_DIR/logs"
mkdir -p $LOG_DIR
LOG_FILE="$LOG_DIR/fra-$(date +%Y%m%d).log"

echo "📋 Logging to: $LOG_FILE"

# Ensure we have proper cache directory access
mkdir -p $ROOT_DIR/cache

# Function to run the strategy with logging
run_strategy() {
  echo "▶️ $(date): Running Funding Rate Arbitrage strategy..." | tee -a "$LOG_FILE"
  node $ROOT_DIR/strategies/funding-rate-arbitrage.js 2>&1 | tee -a "$LOG_FILE"
  local exit_code=${PIPESTATUS[0]}
  
  if [ $exit_code -ne 0 ]; then
    echo "❌ $(date): Strategy execution failed with exit code $exit_code" | tee -a "$LOG_FILE"
  else
    echo "✅ $(date): Strategy execution completed" | tee -a "$LOG_FILE"
  fi
  
  return $exit_code
}

# Main loop
while true; do
  run_strategy
  
  echo "⏳ Waiting ${INTERVAL} seconds until next run..." | tee -a "$LOG_FILE"
  sleep $INTERVAL
done