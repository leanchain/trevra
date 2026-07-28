#!/usr/bin/env bash
# Retries `terraform apply` until A1 capacity frees up.
#
# "Out of host capacity" on VM.Standard.A1.Flex is a transient tenancy-wide
# shortage, not a configuration fault -- capacity is released in bursts as other
# Always Free users release instances, so the fix is patience plus retries.
#
# Networking and the block volume already exist and are not recreated; each
# attempt only retries the instance and its attachment.
#
# Usage:  ./retry-apply.sh [interval_seconds] [max_attempts]
set -uo pipefail

INTERVAL="${1:-300}"
MAX="${2:-288}" # 288 x 300s = 24h
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/terraform" && pwd)"
LOG="${DIR}/retry-apply.log"

cd "$DIR"
echo "$(date -Is) starting: interval=${INTERVAL}s max=${MAX}" | tee -a "$LOG"

for attempt in $(seq 1 "$MAX"); do
  out=$(terraform apply -auto-approve -input=false -no-color 2>&1)

  if grep -q 'Apply complete' <<<"$out"; then
    ip=$(terraform output -raw public_ip 2>/dev/null)
    echo "$(date -Is) attempt ${attempt}: SUCCESS public_ip=${ip}" | tee -a "$LOG"
    exit 0
  fi

  if grep -q 'Out of host capacity' <<<"$out"; then
    echo "$(date -Is) attempt ${attempt}/${MAX}: out of capacity, retrying in ${INTERVAL}s" | tee -a "$LOG"
    sleep "$INTERVAL"
    continue
  fi

  # Anything else is a real error; stop rather than hammer the API.
  echo "$(date -Is) attempt ${attempt}: unexpected failure, stopping" | tee -a "$LOG"
  tail -20 <<<"$out" | tee -a "$LOG"
  exit 1
done

echo "$(date -Is) exhausted ${MAX} attempts without capacity" | tee -a "$LOG"
exit 1
