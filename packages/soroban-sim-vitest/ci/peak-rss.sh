#!/usr/bin/env bash
# Runs COMMAND while sampling the resident memory of every process named NAME
# every 100 ms, and writes "<peak summed RSS in MiB> <most processes at once>"
# to OUT. Sampling can miss a spike shorter than the interval.
#   peak-rss.sh NAME OUT -- COMMAND...
set -euo pipefail
name=$1 out=$2
shift 3

sample() {
  local peak=0 most=0
  while :; do
    local pids kib count
    pids=$(pgrep -x "$name" | paste -sd, - || true)
    if [ -n "$pids" ]; then
      kib=$({ ps -o rss= -p "$pids" 2>/dev/null || true; } | awk '{ s += $1 } END { print s + 0 }')
      count=$(echo "$pids" | tr ',' '\n' | wc -l | tr -d ' ')
      [ "$kib" -gt "$peak" ] && peak=$kib
      [ "$count" -gt "$most" ] && most=$count
    fi
    awk -v k="$peak" -v n="$most" 'BEGIN { printf "%.1f %d\n", k / 1024, n }' >"$out.tmp"
    mv "$out.tmp" "$out"
    sleep 0.1
  done
}

sample &
sampler=$!
status=0
"$@" || status=$?
sleep 0.2
kill "$sampler" 2>/dev/null || true
wait "$sampler" 2>/dev/null || true
exit "$status"
