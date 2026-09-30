#!/usr/bin/env bash
# Report line coverage on contract money paths (donate, escrow release, lock/withdraw).
#
# Usage:
#   ./scripts/money-path-coverage.sh           # fast profile
#   PROPTEST_CASES=2000 ./scripts/money-path-coverage.sh deep
#
# Writes contracts/coverage-money-paths.xml and prints a summary to stdout.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/contracts"

PROFILE="${1:-fast}"
export PROPTEST_CASES="${PROPTEST_CASES:-32}"
if [[ "$PROFILE" == "deep" ]]; then
  export PROPTEST_CASES="${PROPTEST_CASES:-2000}"
fi

echo "==> Money-path property tests (PROPTEST_CASES=$PROPTEST_CASES)"
cargo test --workspace --features testutils prop_ regression_ -- --test-threads=1

if ! command -v cargo-tarpaulin >/dev/null 2>&1; then
  echo "==> Installing cargo-tarpaulin..."
  cargo install cargo-tarpaulin --locked
fi

OUT="$ROOT/contracts/coverage-money-paths.xml"
echo "==> Collecting coverage -> $OUT"
cargo tarpaulin \
  --workspace \
  --features testutils \
  --out Xml \
  --output-dir "$ROOT/contracts" \
  --filename coverage-money-paths \
  --exclude-files 'test_snapshots/*' \
  --timeout 600 \
  -- \
  --test-threads=1 \
  prop_ regression_

echo "==> Coverage report written to $OUT"
if [[ -f "$OUT" ]]; then
  python3 - <<'PY' "$OUT"
import sys
import xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()
for package in root.findall(".//package"):
    name = package.get("name", "")
    if any(k in name for k in ("greenpay", "escrow", "dao_governance")):
        line_rate = float(package.get("line-rate", 0)) * 100
        print(f"  {name}: {line_rate:.1f}% line coverage")
PY
fi
