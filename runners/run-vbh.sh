#!/bin/bash

# Volatility Breakout Hunter Runner
# Run the VBH strategy in a loop with a configurable interval
# Usage: 
#   ./run-vbh.sh             # uses default 30 minute interval
#   INTERVAL=900 ./run-vbh.sh # uses custom 15 minute interval (900 seconds)

# Default interval is 30 minutes if not specified
INTERVAL=${INTERVAL:-1800}

# Change to the root directory to ensure access to .env and lib files
cd $(dirname $0)/..
ROOT_DIR=$(pwd)

# Create logs directory if it doesn't exist
mkdir -p $ROOT_DIR/logs

# Generate a timestamp for the log file
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
LOG_FILE="$ROOT_DIR/logs/vbh_${TIMESTAMP}.log"

echo "Starting Volatility Breakout Hunter runner with ${INTERVAL} second interval"
echo "Logs will be saved to ${LOG_FILE}"
echo "Press Ctrl+C to stop"

# Add a function to handle exit gracefully
function cleanup {
  echo "Stopping Volatility Breakout Hunter runner..."
  exit 0
}

# Register the cleanup function for SIGINT and SIGTERM
trap cleanup SIGINT SIGTERM

run_strategy() {
  echo "▶️ Running Volatility Breakout Hunter at $(date)" | tee -a "$LOG_FILE"
  echo "-------------------------------------" | tee -a "$LOG_FILE"
  node $ROOT_DIR/strategies/volatility-breakout-hunter.js 2>&1 | tee -a "$LOG_FILE"
  local exit_code=${PIPESTATUS[0]}
  
  if [ $exit_code -ne 0 ]; then
    echo "❌ $(date): Strategy execution failed with exit code $exit_code" | tee -a "$LOG_FILE"
  else
    echo "✅ $(date): Strategy execution completed" | tee -a "$LOG_FILE"
  fi
  
  echo "-------------------------------------" | tee -a "$LOG_FILE"
  echo "" | tee -a "$LOG_FILE"
  
  return $exit_code
}

# Main loop to run the strategy
while true; do
  START_TIME=$(date +%s)
  
  # Print divider in log for readability
  echo -e "\n===============================================" | tee -a "$LOG_FILE"
  echo "Running Volatility Breakout Hunter at $(date)" | tee -a "$LOG_FILE"
  echo "===============================================" | tee -a "$LOG_FILE"
  
  # Run the strategy and capture both stdout and stderr to log file
  run_strategy
  
  # Calculate execution time and time to wait until next run
  END_TIME=$(date +%s)
  EXECUTION_TIME=$((END_TIME - START_TIME))
  
  # Calculate sleep time (ensuring we don't get negative values)
  SLEEP_TIME=$((INTERVAL - EXECUTION_TIME))
  
  if [[ $SLEEP_TIME -le 0 ]]; then
    echo "Execution took longer than interval, running next iteration immediately" | tee -a "$LOG_FILE"
  else
    echo "Execution completed in ${EXECUTION_TIME} seconds" | tee -a "$LOG_FILE"
    echo "Waiting ${SLEEP_TIME} seconds before next run..." | tee -a "$LOG_FILE"
    sleep $SLEEP_TIME
  fi
done 