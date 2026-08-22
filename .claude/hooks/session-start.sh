#!/bin/bash
set -euo pipefail

# The container's global git config sets user.name/user.email to the
# vendor default ("Claude <noreply@anthropic.com>"). Override it locally
# for this repo so every commit made in this session uses the project's
# chosen author identity instead.
git config user.name "Awosdot"
git config user.email "awosdot@gmail.com"
