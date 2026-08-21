#!/usr/bin/env bash
# Browser-verified golden path 2 (buyer journey through the real UI):
#   marketplace → product → checkout (GPS pin + landmark + consent + phone)
#   → method chips → Orange Money → DC-14 USSD screen → provider webhook → PAYÉ → tracking.
#
# Drives a real Chromium via playwright-cli against the running dev stack and captures
# numbered screenshots into docs/reports/browser-evidence/. Repeatable: run-unique guest
# phone, idempotent data hygiene, session isolated under -s=gp.
#
# Prereqs: API on $API_URL (default :3001), web dev server on $WEB_URL (default :3000,
# /api proxy), seeded DB. The webhook is signed exactly as the mock provider would sign
# it (HMAC-SHA256, dev secret) — `paid` still only ever comes from the verified webhook
# path (DC-8.1); nothing here bypasses it.
#
# Usage: scripts/browser-golden-path.sh
#   WEB_URL / API_URL / DATABASE_URL / PRODUCT_TITLE override defaults.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_URL="${WEB_URL:-http://localhost:3000}"
API_URL="${API_URL:-http://localhost:3001}"
DATABASE_URL="${DATABASE_URL:-postgresql://sunu:sunu@localhost:5432/sunumarket}"
PRODUCT_TITLE="${PRODUCT_TITLE:-Robe wax fleurie}"
EVIDENCE="$ROOT/docs/reports/browser-evidence"
SESSION=gp
PHONE="+2217$(date +%s%N | cut -c6-13)"

pw() { (cd "$ROOT" && pnpm exec playwright-cli -s="$SESSION" "$@"); }
shot() { pw screenshot --filename="$1" >/dev/null; echo "  · $(basename "$1")"; }
fail() { echo "FAIL: $1" >&2; pw close >/dev/null 2>&1 || true; exit 1; }

# Wait until the accessibility snapshot contains a string (UI settled), max ~15s.
wait_ui() {
  local needle="$1" i
  for i in $(seq 1 30); do
    if pw --raw snapshot 2>/dev/null | grep -qF "$needle"; then return 0; fi
    sleep 0.5
  done
  fail "timed out waiting for UI text: $needle"
}

echo "== Preflight"
curl -sf -o /dev/null "$API_URL/marketplace" || fail "API not reachable at $API_URL"
curl -sf -o /dev/null "$WEB_URL/" || fail "web dev server not reachable at $WEB_URL"
mkdir -p "$EVIDENCE"
if command -v psql >/dev/null 2>&1; then
  psql "$DATABASE_URL" -q -f "$ROOT/scripts/archive-test-fixtures.sql" \
    || echo "  (fixture archive skipped: psql failed — marketplace may show test products)"
fi
STOCK=$(curl -sf "$API_URL/marketplace" | node -e '
  let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
    const item = JSON.parse(d).items.find((i) => i.title === process.argv[1]);
    process.stdout.write(item ? String(item.stock) : "missing");
  });' "$PRODUCT_TITLE")
[ "$STOCK" = "missing" ] && fail "product '$PRODUCT_TITLE' not on marketplace — run: pnpm --filter @sunumarket/api db:seed"
[ "$STOCK" = "0" ] && fail "product '$PRODUCT_TITLE' out of stock — re-seed to restore dev catalog stock"
echo "  · product '$PRODUCT_TITLE' in stock ($STOCK) · guest phone $PHONE"

echo "== 1. Marketplace"
pw close >/dev/null 2>&1 || true
pw open --mobile "$WEB_URL/#/" >/dev/null
# Grant geolocation with a Dakar Médina position (the UI also has a graceful
# fallback pin if geolocation is denied — both paths end at the same screen).
pw run-code "async page => { const ctx = page.context(); await ctx.grantPermissions(['geolocation']); await ctx.setGeolocation({ latitude: 14.6828, longitude: -17.4467 }); }" >/dev/null
wait_ui "$PRODUCT_TITLE"
shot "$EVIDENCE/01-marketplace.png"

echo "== 2. Product page (DC-16 trust block)"
pw click "getByRole('link', { name: /$PRODUCT_TITLE/ })" >/dev/null
wait_ui "Commander"
shot "$EVIDENCE/02-product.png"

echo "== 3. Checkout: GPS pin + landmark + consent + phone"
pw click "getByRole('button', { name: 'Commander' })" >/dev/null
wait_ui "Point de livraison"
pw click "getByRole('button', { name: /Utiliser ma position GPS/ })" >/dev/null
wait_ui "Frais de livraison"
pw fill "getByRole('textbox', { name: /Repère/ })" "En face de la pharmacie Ndiaye, Médina" >/dev/null
pw fill "getByRole('textbox', { name: /numéro de téléphone/ })" "$PHONE" >/dev/null
pw check "getByRole('checkbox', { name: /accepte/ })" >/dev/null
shot "$EVIDENCE/03-checkout-filled.png"

echo "== 4. Order created → method chips"
pw click "getByRole('button', { name: 'Paiement →' })" >/dev/null
wait_ui "Choisissez votre moyen de paiement"
shot "$EVIDENCE/04-methods.png"

echo "== 5. Orange Money → DC-14 USSD screen"
pw click "getByRole('button', { name: /^Orange Money/ })" >/dev/null
pw click "getByRole('button', { name: 'Payer maintenant' })" >/dev/null
wait_ui "Confirmez sur votre téléphone"
shot "$EVIDENCE/05-ussd.png"

echo "== 6. Provider confirms (signed mock webhook — the DC-8.1 'paid' path)"
ATTEMPT=$(psql "$DATABASE_URL" -At -c "
  SELECT pp.code || '|' || a.provider_ref
  FROM payment_attempts a
  JOIN orders o ON o.id = a.order_id
  JOIN payment_providers pp ON pp.id = a.provider_id
  WHERE o.guest_phone = '$PHONE' AND a.status = 'ussd_pending'
  ORDER BY a.created_at DESC LIMIT 1")
[ -n "$ATTEMPT" ] || fail "no ussd_pending attempt found for $PHONE"
CODE="${ATTEMPT%%|*}"; REF="${ATTEMPT##*|}"
case "$CODE" in
  AGG_A) SECRET="${MOCK_AGG_A_SECRET:-agg-a-secret}" ;;
  AGG_B) SECRET="${MOCK_AGG_B_SECRET:-agg-b-secret}" ;;
  *) fail "unexpected provider $CODE" ;;
esac
SIGNED=$(node -e '
  const { createHmac, randomUUID } = require("node:crypto");
  const [code, secret, ref] = process.argv.slice(1);
  const body = JSON.stringify({ provider_code: code, event_id: randomUUID(), provider_ref: ref,
    kind: "payment_succeeded", occurred_at: new Date().toISOString() });
  process.stdout.write(createHmac("sha256", secret).update(body).digest("hex") + "\n" + body);
' "$CODE" "$SECRET" "$REF")
SIG=$(printf '%s' "$SIGNED" | head -1); BODY=$(printf '%s' "$SIGNED" | tail -1)
OUTCOME=$(curl -sf -X POST "$API_URL/webhooks/$(echo "$CODE" | tr 'A-Z' 'a-z')" \
  -H "content-type: application/json" -H "x-signature: $SIG" --data "$BODY")
echo "  · webhook outcome: $OUTCOME"
echo "$OUTCOME" | grep -q applied || fail "webhook not applied"

echo "== 7. PAYÉ"
wait_ui "PAYÉ"
shot "$EVIDENCE/06-paid.png"

echo "== 8. Tracking"
pw click "getByRole('link', { name: /Suivi de commande/ })" >/dev/null
wait_ui "Statut"
shot "$EVIDENCE/07-tracking.png"

pw close >/dev/null
echo "== DONE — evidence in docs/reports/browser-evidence/ (01→07)"
