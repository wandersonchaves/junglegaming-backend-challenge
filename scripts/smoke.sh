#!/usr/bin/env bash
# Exercises the running API end to end. Usage: bun run start (other terminal), then: bash scripts/smoke.sh
set -u
BASE="${BASE_URL:-http://localhost:3000}"
RUN="$(date +%s)$RANDOM"
PLAYER="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen | tr 'A-Z' 'a-z')"
PASS=0; FAIL=0

json() { curl -s -o /tmp/smoke_body -w '%{http_code}' -X POST "$BASE$1" -H 'content-type: application/json' "${@:3}" -d "$2"; }
field() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" /tmp/smoke_body | head -1; }
check() { # name expected actual
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  ok   $1 ($3)"; else FAIL=$((FAIL+1)); echo "  FAIL $1: expected $2, got $3"; cat /tmp/smoke_body; echo; fi
}
bet() { # name amount kind [extra json fields]
  printf '{"providerId":"provider-a","externalTransactionId":"%s-%s","playerId":"%s","walletId":"%s","roundId":"round-1","gameId":"fortune-chimp","kind":"%s","money":{"amount":"%s","currency":"BRL"}%s}' \
    "$RUN" "$1" "$PLAYER" "$WALLET" "${3:-BET}" "$2" "${4:-}"
}

echo "1. wallet"
code=$(json /wallets "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}")
check "create wallet" 201 "$code"; WALLET=$(field id)
code=$(json /wallets "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"1.00\",\"currency\":\"BRL\"}}")
check "duplicate wallet" 409 "$code"

echo "2. idempotency"
B1=$(bet one 25.00)
code=$(json /wagering/transactions "$B1" -H "Idempotency-Key: provider-a:$RUN-one"); check "new bet" 201 "$code"
code=$(json /wagering/transactions "$B1" -H "Idempotency-Key: provider-a:$RUN-one"); check "same request again (replay)" 200 "$code"
code=$(json /wagering/transactions "$(bet one 26.00)" -H "Idempotency-Key: provider-a:$RUN-one"); check "same key, other payload" 409 "$code"
code=$(json /wagering/transactions "$B1"); check "missing Idempotency-Key" 400 "$code"
code=$(json /wagering/transactions "$(bet bad 1e3)" -H "Idempotency-Key: k-$RUN-bad"); check "malformed amount" 400 "$code"

echo "3. business rules"
code=$(json /wagering/transactions "$(bet big 900.00)" -H "Idempotency-Key: provider-a:$RUN-big"); check "insufficient funds" 422 "$code"
code=$(json /wagering/transactions "$(bet early 5.00 REFUND ',"referenceExternalTransactionId":"never-arrives"')" -H "Idempotency-Key: provider-a:$RUN-early"); check "reference not here yet" 202 "$code"
code=$(json /wagering/transactions "$(bet refund 25.00 REFUND ",\"referenceExternalTransactionId\":\"$RUN-one\"")" -H "Idempotency-Key: provider-a:$RUN-refund"); check "refund of the first bet" 201 "$code"
code=$(json /wagering/transactions "$(bet refund2 25.00 REFUND ",\"referenceExternalTransactionId\":\"$RUN-one\"")" -H "Idempotency-Key: provider-a:$RUN-refund2"); check "second refund of the same bet" 422 "$code"

echo "4. 50 identical requests in parallel (expect one 201 and forty-nine 200)"
BURST=$(bet burst 10.00)
codes=$(seq 1 50 | xargs -P 50 -I{} curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/wagering/transactions" \
  -H 'content-type: application/json' -H "Idempotency-Key: provider-a:$RUN-burst" -d "$BURST")
check "burst: one created" 1 "$(echo "$codes" | grep -c '^201$')"
check "burst: replays" 49 "$(echo "$codes" | grep -c '^200$')"

echo "5. two bets racing for the last balance"
code=$(json /wagering/transactions "$(bet drain 80.00)" -H "Idempotency-Key: provider-a:$RUN-drain"); check "drain the wallet to a known amount" 201 "$code"
# balance now 100 - 25 + 25 (refund) - 10 (burst) - 80 = 10.00; two bets of 8.00 can only fit once
codes=$( (curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/wagering/transactions" -H 'content-type: application/json' -H "Idempotency-Key: provider-a:$RUN-r1" -d "$(bet r1 8.00)" &
          curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/wagering/transactions" -H 'content-type: application/json' -H "Idempotency-Key: provider-a:$RUN-r2" -d "$(bet r2 8.00)" &
          wait) | sort | tr '\n' ' ')
check "one accepted, one rejected" "201 422 " "$codes"

echo; echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]
