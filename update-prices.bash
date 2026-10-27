#!/bin/bash
# APY-6 Fix: Shell hardening applied.

set -euo pipefail

result_file="$(mktemp)"
trap 'rm -f "$result_file"' EXIT

mkdir -p ./db

now="$(date -Iseconds)"

pnpm run start > "$result_file"

epoch="$(awk '/^epoch [0-9]+$/ {print $2}' "$result_file")"

if [[ -z "$epoch" ]]
then
    echo "Epoch not found in the result file!" >&2
    exit 1
fi

# Define a regex pattern to match the "epoch" line
EPOCH_PATTERN="^epoch [0-9]+$"
# Set the flag to start processing lines after the epoch line is found
START_PROCESSING=false

# Read the input file line by line
while IFS= read -r line; do
  if [[ $line =~ $EPOCH_PATTERN ]]; then
    START_PROCESSING=true
    continue
  fi

  if $START_PROCESSING; then
    pool="$(echo "$line" | awk '{print $1}')"
    price="$(echo "$line" | awk '{$1=""; print $0}' | sed 's/^ *//; s/ *$//')"

    # APY-6 Fix: Pool names come from program output and are used as a file name.
    # Reject anything that is not a simple path component to prevent path traversal.
    if [[ ! "$pool" =~ ^[A-Za-z0-9_-]+$ ]]; then
      echo "Invalid pool name: $pool" >&2
      exit 1
    fi

    if [[ -z "$price" ]]; then
      echo "Missing price for pool: $pool" >&2
      exit 1
    fi

    db_file="./db/${pool}.csv"
    if [ ! -f "$db_file" ]; then
      echo "timestamp,epoch,price" > "$db_file"
    fi
    # APY-6 Fix: Prevent command/path injection by writing strictly formatted variables
    printf '%s,%s,%s\n' "$now" "$epoch" "$price" >> "$db_file"

    echo "Updated or created file: ${pool}.csv with content: $price"
  fi
done < "$result_file"