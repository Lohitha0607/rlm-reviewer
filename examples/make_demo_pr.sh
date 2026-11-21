#!/bin/bash
# Build a tiny repo with a pull-request branch that contains two planted bugs:
#   1. refunds use ">= 500" although the PR says "strictly over $500"
#   2. average() divides by len(items) without handling an empty cart
set -euo pipefail
DIR="${1:-/tmp/rlm-demo-repo}"
rm -rf "$DIR" && mkdir -p "$DIR/shop" && cd "$DIR"
git init -q -b main && git config user.email demo@example.com && git config user.name demo

cat > shop/cart.py <<'PY'
def total(items):
    return sum(item.price for item in items)
PY
cat > shop/refunds.py <<'PY'
def can_refund(order):
    return False
PY
git add -A && git commit -q -m "Initial shop"

git checkout -q -b add-refunds
cat > shop/cart.py <<'PY'
def total(items):
    return sum(item.price for item in items)


def average(items):
    return total(items) / len(items)
PY
cat > shop/refunds.py <<'PY'
REFUND_THRESHOLD = 500


def can_refund(order):
    if order.status != "delivered":
        return False
    return order.amount >= REFUND_THRESHOLD
PY
git add -A && git commit -q -m "Add refunds for big orders and cart average"
echo "$DIR"
