#!/bin/bash
# APY-6 Fix: Shell hardening applied.

set -euo pipefail

shopt -s nullglob

for db_file in db/*.csv; do
    tmp_file="$(mktemp)"
    cp "$db_file" "$tmp_file"

    # APY-6 Fix: Write to a temporary file next to the target and move it into place so
    # an interrupted run cannot leave a truncated CSV behind (Atomic Rewrite).
    awk -F , '
        current_epoch = $2
        if (current_epoch != previous_epoch && NR > 1) {
            print first_date "," previous_epoch "," last_value
        }
        if (current_epoch != previous_epoch) {
            first_date = $1
        }
        last_value = $3
        previous_epoch = current_epoch
    END {
        print first_date "," previous_epoch "," last_value
    }' "$tmp_file" > "${db_file}.tmp"

    mv "${db_file}.tmp" "$db_file"
    rm "$tmp_file"
done