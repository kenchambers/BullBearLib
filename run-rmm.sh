#!/bin/bash

# RMM Strategy Runner (Demo-focused)
# Usage: 
#   ./run-rmm.sh              # Default 2-min cadence for very frequent trades
#   INTERVAL=60 ./run-rmm.sh  # Custom 1-min interval for maximum activity

# Default interval is 2 minutes (120 seconds) for demonstration purposes
INTERVAL=${INTERVAL:-120}

echo "🔄 Starting RMM Demo Strategy Runner (interval: ${INTERVAL}s)"
echo "📊 Press Ctrl+C to stop"

# Ensure we have proper directory access
mkdir -p cache

# Run continuously until interrupted
while true; do
  echo "▶️ $(date): Running RMM strategy..."
  node strategies/rmm-strategy.js
  
  echo "⏳ Waiting ${INTERVAL} seconds until next run..."
  sleep ${INTERVAL}
done 