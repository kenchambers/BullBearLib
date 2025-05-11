#!/bin/bash

# Funding-Skew Reversal (FSR) Strategy Runner
# -------------------------------------------
# Run the FSR strategy at regular intervals
# Default interval: 30 minutes (1800 seconds)
# Override with: INTERVAL=<seconds> ./run-fsr.sh

# Set log file
LOG_DIR="./logs"
LOG_FILE="$LOG_DIR/fsr-$(date +%Y%m%d).log"

# Create logs directory if it doesn't exist
mkdir -p $LOG_DIR

# Set default interval if not provided
INTERVAL=${INTERVAL:-1800}

echo "==== FSR Strategy Runner ====" | tee -a "$LOG_FILE"
echo "Starting with interval: $INTERVAL seconds" | tee -a "$LOG_FILE"
echo "Logs: $LOG_FILE" | tee -a "$LOG_FILE"
echo "Started at: $(date)" | tee -a "$LOG_FILE"
echo "==========================" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

# Function to run the strategy
run_strategy() {
    echo "Running FSR Strategy at $(date)" | tee -a "$LOG_FILE"
    echo "-------------------------" | tee -a "$LOG_FILE"
    
    # Run the strategy
    node strategies/funding-skew-reversal.js 2>&1 | tee -a "$LOG_FILE"
    
    echo "-------------------------" | tee -a "$LOG_FILE"
    echo "Completed at $(date)" | tee -a "$LOG_FILE"
    echo "" | tee -a "$LOG_FILE"
}

# Run immediately on start
run_strategy

# Then run at intervals
while true; do
    echo "Waiting $INTERVAL seconds until next run..." | tee -a "$LOG_FILE"
    sleep $INTERVAL
    run_strategy
done 