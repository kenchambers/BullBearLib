#!/bin/bash

# TFOID Strategy Runner
# Usage: 
#   ./run-tfoid.sh              # Default 30-min cadence 
#   INTERVAL=900 ./run-tfoid.sh # Custom 15-min cadence

# Default interval is 30 minutes (1800 seconds)
INTERVAL=${INTERVAL:-1800}

echo "🔄 Starting TFOID Strategy Runner (interval: ${INTERVAL}s)"
echo "📊 Press Ctrl+C to stop"

# Ensure we have proper directory access
mkdir -p cache

# Run continuously until interrupted
while true; do
  echo "▶️ $(date): Running TFOID strategy..."
  node strategies/tfoid-strategy.js
  
  echo "⏳ Waiting ${INTERVAL} seconds until next run..."
  sleep ${INTERVAL}
done 