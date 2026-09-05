#!/usr/bin/env python3
"""
scripts/create_hook_tooling_issues.py

Opens five large contributor issues covering the git-hook tooling this
repository has none of, plus the engines the hooks would drive.

Scope note: husky itself is a thin git-hook runner — its own setup is a few
lines of config. The substantial work is the tooling a hook invokes, which is
where these five issues sit. Each is sized so a contributor writes real
engineering rather than glue.

Idempotent: fetches every existing issue title first and skips anything
already present, and refuses to run if two issues in this batch share a title.

    export GITHUB_TOKEN=ghp_...        # needs 'repo' scope
    python3 scripts/create_hook_tooling_issues.py --dry-run
    python3 scripts/create_hook_tooling_issues.py
"""
import argparse
import os
import subprocess
import sys
import time

import requests

REPO = "Stellar-Search/GreenPay"
API = f"https://api.github.com/repos/{REPO}"

TOKEN = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
if not TOKEN:
    try:
        TOKEN = subprocess.check_output(["gh", "auth", "token"], text=True).strip()
    except Exception:
        TOKEN = None
if not TOKEN:
    print("ERROR: no GitHub token found. Set GITHUB_TOKEN or run `gh auth login`.", file=sys.stderr)
    sys.exit(1)

SESSION = requests.Session()
SESSION.headers.update(
    {
        "Authorization": f"Bearer {TOKEN}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
)


def existing_titles() -> set:
    titles, page = set(), 1
    while True:
        r = SESSION.get(f"{API}/issues", params={"state": "all", "per_page": 100, "page": page})
        r.raise_for_status()
        batch = r.json()
        if not batch:
            break
        for it in batch:
            if "pull_request" not in it:
                titles.add(it["title"])
        if len(batch) < 100:
            break
        page += 1
    return titles


FOOTER = (
    "\n\n---\n\n"
    "*Part of a set of five issues covering git-hook tooling. `husky` itself is a thin "
    "hook runner — its own configuration is a handful of lines. The engineering lives in "
    "the tooling a hook invokes, which is what these issues specify.*"
)


def body_for(issue: dict) -> str:
    parts = [
        "## Summary\n\n" + issue["summary"],
        "## Evidence\n\n" + issue["evidence"],
        "## Why this is hard\n\n" + issue["hard"],
        "## Suggested approach\n\n" + issue["approach"],
        "## Acceptance criteria\n\n"
        + "\n".join(f"- [ ] {c}" for c in issue["acceptance"]),
        "## Scope\n\n" + issue["scope"],
        "## Relevant files\n\n"
        + "\n".join(f"- `{f}`" for f in issue["files"]),
    ]
    return "\n\n".join(parts) + FOOTER


def create_issue(issue: dict, dry_run: bool = False) -> None:
    title = f"{issue['area']}: {issue['title']}"
    labels = ["complexity: high", issue["label"]]
    if issue.get("security"):
        labels.append("security")
    if dry_run:
        print(f"    [dry-run] {title}  {labels}")
        return
    r = SESSION.post(f"{API}/issues", json={"title": title, "body": body_for(issue), "labels": labels})
    if r.status_code >= 300:
        print(f"    ERROR {r.status_code}: {r.text[:300]}", file=sys.stderr)
        r.raise_for_status()
    print(f"    created #{r.json()['number']}")


def B(area, label, title, summary, evidence, hard, approach, acceptance, scope, files, security=False):
    return dict(area=area, label=label, title=title, summary=summary, evidence=evidence,
                hard=hard, approach=approach, acceptance=acceptance, scope=scope,
                files=files, security=security)


ISSUES = [

    # ─────────────────────────────────────────────────────────────────────────
    B(
        area="Infra",
        label="area: infra",
        title="Build the pre-commit gate: eight toolchains, no root manifest, and staged-content correctness",
        summary=(
            "This repository has no git hooks of any kind. `.husky/` does not exist, no `package.json` "
            "declares `husky`, `lint-staged` or `commitlint`, `core.hooksPath` is unset, and `.git/hooks/` "
            "contains nothing but samples. Every check runs only after a push, so a contributor learns "
            "about a formatting failure or a broken import from a red CI run minutes later.\n\n"
            "Installing husky is trivial. Making a pre-commit gate that is *correct and fast* in this "
            "repository is not, because there is no root manifest to hang it off and eight independent "
            "toolchains to route to."
        ),
        evidence=(
            "```\n"
            "$ ls .husky                  → does not exist\n"
            "$ git config core.hooksPath  → unset\n"
            "$ ls .git/hooks | grep -v sample → (nothing)\n"
            "$ ls package.json            → no root manifest\n"
            "\n"
            "npm workspaces : backend  frontend  mobile  extension  shared\n"
            "other          : contracts/Cargo.toml   scheduler/go.mod\n"
            "config/YAML    : k8s/  helm/  .github/workflows/\n"
            "```\n\n"
            "Each npm workspace has its own lockfile and its own scripts; `mobile` and `extension` do not "
            "even share a test runner (jest vs vitest). There is no single command that lints \"the repo\"."
        ),
        hard=(
            "**Staged content, not working-tree content.** A file can be staged with further unstaged edits "
            "on top. Linting the working tree passes or fails on code that is not being committed, and "
            "auto-fixing it silently destroys unstaged work. The gate has to operate on the staged blobs, "
            "and restore the working tree exactly on every exit path including a crash or a `SIGINT`.\n\n"
            "**Routing.** Staged paths must map to the right toolchain, and only the affected ones should "
            "run. Touching `contracts/` must not run `tsc`; touching one workspace must not lint the other "
            "four. The mapping has to cope with files that belong to no toolchain and files that belong to "
            "two (`shared/` is consumed by both frontend and mobile).\n\n"
            "**Missing toolchains.** Most contributors will not have Rust and Go installed. The gate must "
            "degrade to a clear skip with a reason, never a confusing failure, and CI must still enforce "
            "what was skipped locally.\n\n"
            "**Speed.** A pre-commit hook that takes 40 seconds gets bypassed with `--no-verify` and then "
            "it protects nothing. There is a real performance budget here and it drives the design: "
            "parallelism, per-toolchain incremental scoping, and caching.\n\n"
            "**Divergence.** If the hook and CI implement the same checks twice they will drift apart. One "
            "of them will pass while the other fails, and contributors will stop trusting the hook."
        ),
        approach=(
            "Add husky and a small root manifest that exists only to host developer tooling — it must not "
            "become a place where runtime dependencies accumulate, so document that boundary and consider "
            "enforcing it.\n\n"
            "Write a router that takes the staged path list and produces a plan: which toolchains to invoke, "
            "with which file subsets, in what order, and what may run concurrently. Express the mapping in "
            "config rather than code so adding a workspace is a config edit.\n\n"
            "Extract staged content safely. `git stash --keep-index` is the well-known approach and it is "
            "also the one that loses work when the hook dies partway; whichever mechanism is chosen, prove "
            "recovery under an interrupt.\n\n"
            "Expose the same plan to CI so the hook and the workflow run one implementation. A `--all` mode "
            "that ignores staging is what CI invokes."
        ),
        acceptance=[
            "Committing a change in one workspace runs only that workspace's checks, proven by a test.",
            "Checks read staged content: a file staged clean with a broken unstaged edit on top commits successfully, and the unstaged edit survives untouched.",
            "The working tree is restored on success, on failure, and on `SIGINT` during a check — each covered by a test.",
            "A missing Rust or Go toolchain produces a named skip, not a failure, and the skip is listed in the hook's output.",
            "The gate completes within a documented budget on a representative commit; the measurement is reproducible and recorded.",
            "CI and the hook invoke the same planner, so a check cannot exist in one and not the other.",
            "`--no-verify` usage is documented, and there is a policy decision recorded on whether CI re-runs everything regardless.",
            "Fresh-clone bootstrap works on Linux, macOS and Windows, including CRLF checkouts.",
        ],
        scope=(
            "Roughly **3,000–5,000 lines**: the planner and its config schema, one adapter per toolchain, "
            "staged-content extraction with crash-safe restore, a concurrency scheduler, a reporter, and the "
            "fixture repositories and tests needed to prove the staging and interrupt behaviour."
        ),
        files=[
            ".husky/ (new)",
            "package.json (new, tooling-only root manifest)",
            "scripts/ (planner and toolchain adapters)",
            ".github/workflows/ci.yml",
        ],
    ),

    # ─────────────────────────────────────────────────────────────────────────
    B(
        area="Cross-cutting",
        label="area: cross-cutting",
        title="Unify the one-off repository checks into an invariant engine with autofix and baselines",
        summary=(
            "Five standalone check scripts have accumulated, in two languages, with five different output "
            "formats and no shared concept of a rule, a suppression, or an exit contract. Each new invariant "
            "means another bespoke script and another CI step. There is no way to run them against staged "
            "files only, none of them can fix anything, and none produces machine-readable output.\n\n"
            "Turn them into rules on a single engine that a pre-commit hook and CI both drive."
        ),
        evidence=(
            "```\n"
            "scripts/check-documented-commands.js   node, prose output\n"
            "scripts/check-env-example.js           node, prose output\n"
            "scripts/check-source-encoding.js       node, prose output\n"
            "scripts/check-translations.js          node, prose output\n"
            "scripts/check-k8s-manifests.py         python + PyYAML\n"
            "```\n\n"
            "The language split is not a preference — it is forced. The k8s check needs a YAML parser and "
            "the CI job that runs these installs no dependencies, so it could not be written in Node. That "
            "constraint is real and the engine has to answer it rather than ignore it.\n\n"
            "Every one of these scripts was added *after* the defect it detects had already shipped."
        ),
        hard=(
            "**Two runtimes, one engine.** Some invariants need a YAML parser, some need a TypeScript AST, "
            "some need to shell out to `git`. Deciding whether the engine hosts both runtimes, standardises "
            "on one and pays the dependency cost, or defines a subprocess rule protocol is the central "
            "design decision and it deserves an ADR.\n\n"
            "**Autofix is where correctness gets subtle.** A fixer that rewrites a file the user has staged "
            "partially will destroy unstaged work. Fixers must be idempotent, must not fight each other when "
            "two rules touch one file, and must be separable into safe and unsafe tiers.\n\n"
            "**Baselines.** Introducing a rule against an existing codebase means thousands of pre-existing "
            "violations. Without a baseline the rule cannot be adopted; with a permanent baseline it never "
            "gets cleaned up. Suppressions need expiry and a reason, and expiry has to fail the build.\n\n"
            "**Staged vs whole-tree.** The same rule must be able to run over a staged subset in a hook and "
            "the whole tree in CI, and report identically."
        ),
        approach=(
            "Define a rule interface: identify targets from a file list, report findings with a path, a "
            "position and a stable rule id, and optionally supply a fix. Migrate the five existing scripts "
            "as the first rules so the engine is proven against real invariants rather than toy ones.\n\n"
            "Then add rules for defect classes this repository has actually shipped: source files in a "
            "non-UTF-8 encoding, unresolvable relative imports, Stellar addresses validated by regex instead "
            "of a checksum, and monetary values read through `parseFloat`.\n\n"
            "Emit both human output and a machine-readable format so the same run can annotate a pull "
            "request. Keep the exit contract explicit: what fails a hook may differ from what fails CI, and "
            "that difference should be configuration, not code."
        ),
        acceptance=[
            "All five existing checks run as rules on the engine and their CI steps collapse into one invocation.",
            "A rule can run against a staged file subset and against the whole tree, reporting identically.",
            "Fixers are idempotent — running twice produces the same tree — and are split into safe and unsafe tiers.",
            "Applying a fixer never modifies unstaged content, proven by a test with a partially staged file.",
            "Baselines record existing violations with a reason and an expiry date; an expired suppression fails the run.",
            "Machine-readable output is produced alongside human output and is consumed by a CI annotation step.",
            "At least four new rules ship, covering encoding, unresolvable imports, regex address validation and float money.",
            "Adding a rule requires no engine changes, demonstrated by a documented worked example.",
            "The runtime decision — one language, two, or a subprocess protocol — is recorded as an ADR under `docs/adr/`.",
        ],
        scope=(
            "Roughly **4,000–6,000 lines**: the engine, rule and fix APIs, the baseline store with expiry, "
            "two reporters, the five migrated rules, four or more new rules with fixers, and the fixture "
            "trees needed to test staged-subset behaviour."
        ),
        files=[
            "scripts/check-documented-commands.js",
            "scripts/check-env-example.js",
            "scripts/check-source-encoding.js",
            "scripts/check-translations.js",
            "scripts/check-k8s-manifests.py",
            "docs/adr/",
        ],
    ),

    # ─────────────────────────────────────────────────────────────────────────
    B(
        area="Cross-cutting",
        label="area: cross-cutting",
        title="One validation source of truth enforced across Node, browser, React Native and Rust",
        summary=(
            "The same rules — what a valid Stellar address is, what a donation amount may be, which project "
            "statuses exist — are reimplemented independently in four runtimes and disagree with each other. "
            "Nothing detects the divergence, so a value can pass validation in the browser, pass again in the "
            "backend, and then be rejected by the contract, surfacing to the donor as an opaque failure after "
            "they have already committed.\n\n"
            "Define each rule once in a machine-readable form, derive or verify every runtime's implementation "
            "against it, and enforce that with a shared conformance suite the pre-commit gate runs."
        ),
        evidence=(
            "Eight files still validate Stellar addresses with a hand-rolled regex:\n\n"
            "```\n"
            "backend/src/eventSourcing/commands.js   3 occurrences\n"
            "backend/src/schemas/common.js           1\n"
            "backend/src/routes/profiles.js          1\n"
            "backend/src/routes/impact.js            1\n"
            "extension/src/session-state.ts          2\n"
            "extension/src/content-script.ts         2\n"
            "frontend/pages/submit-project.tsx       1\n"
            "```\n\n"
            "Two different patterns are in use. `[A-Z0-9]` is simply wrong — Stellar keys are base32, whose "
            "alphabet excludes `0`, `1`, `8` and `9`. `[A-Z2-7]` has the right alphabet but still checks no "
            "checksum. **Only the SDK's `StrKey` verifies the trailing CRC16**, which is the entire point of "
            "the encoding: a single mistyped character in a pasted address passes every regex variant.\n\n"
            "This is not hypothetical. Three of the four seeded demo wallet addresses in "
            "`backend/src/services/store.js` were invalid — two were 55 characters and one had a bad "
            "checksum — and shipped that way until a StrKey check was added."
        ),
        hard=(
            "**Four runtimes that cannot share a module.** Node, the browser bundle, React Native under "
            "Metro, and Rust compiled to WASM. A single shared package cannot cover all four, so the design "
            "has to be a machine-readable definition plus per-runtime implementations that are *proven* "
            "equivalent rather than assumed to be.\n\n"
            "**Authority.** Where the contract enforces a bound, the contract wins — it is the layer that "
            "cannot be bypassed. Where it does not, the backend is authoritative. Encoding that hierarchy, "
            "rather than picking whichever implementation happens to be strictest, is the core modelling "
            "problem.\n\n"
            "**Muxed and contract addresses.** `M…` and `C…` addresses are currently rejected implicitly, by "
            "accident of the regex rather than by decision. The definition has to state what happens to them.\n\n"
            "**Drift detection must be structural.** A conformance suite that each runtime opts into will "
            "rot. Failing to implement a rule has to be a failure, not a silent absence."
        ),
        approach=(
            "Write the rules as data: field, type, constraints, and the failure code each violation produces. "
            "Generate what can be generated and verify what cannot.\n\n"
            "Ship one shared vector file — valid addresses, checksum-invalid addresses, wrong-alphabet "
            "strings, muxed and contract addresses, boundary amounts, every status value — and have every "
            "runtime execute it in its own test suite. A runtime that does not implement a rule fails the "
            "conformance run rather than skipping it.\n\n"
            "Wire the conformance runner into the pre-commit gate so a change to the definition that leaves "
            "an implementation behind cannot be committed."
        ),
        acceptance=[
            "Validation rules are defined once in a machine-readable form, with the contract authoritative wherever it applies.",
            "No `G[A-Z0-9]{55}` or `G[A-Z2-7]{55}` pattern decides address validity anywhere in the repository.",
            "Every subsystem validates through `StrKey` or the Rust equivalent, behind one named helper per runtime.",
            "Muxed (`M…`) and contract (`C…`) address handling is an explicit, documented decision.",
            "A shared vector file is executed by the backend, frontend, mobile, extension and contract test suites.",
            "A runtime that fails to implement a defined rule fails the conformance run rather than silently skipping it.",
            "Amount bounds and project status values are covered by the same mechanism, not only addresses.",
            "The pre-commit gate runs conformance when the definition or any implementation changes.",
            "A worked example documents how to add a new rule and propagate it to all runtimes.",
        ],
        scope=(
            "Roughly **4,000–6,000 lines**: the rule definition format, generator or verifier, five runtime "
            "adapters, the conformance vector corpus and runner, replacement of the existing hand-rolled "
            "validators, and the tests proving each runtime agrees."
        ),
        files=[
            "backend/src/schemas/common.js",
            "frontend/lib/stellar.ts",
            "mobile/utils/stellarValidation.ts",
            "extension/src/session-state.ts",
            "contracts/greenpay-contract/src/lib.rs",
            "shared/",
        ],
        security=True,
    ),

    # ─────────────────────────────────────────────────────────────────────────
    B(
        area="Cross-cutting",
        label="area: cross-cutting",
        title="A lint rule pack for the bug classes this repository actually ships",
        summary=(
            "The bugs that reach `main` here are not generic JavaScript mistakes — they are a small number of "
            "recurring, repository-specific patterns. Generic ESLint configuration cannot see any of them. "
            "Build a rule pack that encodes these specific mistakes, with fixers where a fix is unambiguous, "
            "and run it from the pre-commit gate so they are caught before review rather than after release."
        ),
        evidence=(
            "**Money read as float.** The schema stores 13 columns as `NUMERIC(20, 7)` — exact decimal at "
            "stroop precision, returned by the driver as strings to preserve it. That care is then discarded "
            "by **62 `parseFloat` calls in `backend/src/`** and **36 in `frontend/`**. Seven decimal places "
            "across a twenty-digit range exceeds what a double represents exactly, so sums drift and a "
            "project can read as funded while a stroop short.\n\n"
            "**Response envelope depth.** A response interceptor unwraps `{ success, data }` and replaces "
            "`response.data` with the inner payload. Five call sites disagreed about that: some read one "
            "level too deep, so admin login stored an undefined token and could not leave the login page.\n\n"
            "**Unresolvable imports.** `mobile/app/donate/[id].tsx` imported `useWallet` and `WalletConnect` "
            "from `../../hooks/` and `../../components/` when both live under `../../src/`. Metro could not "
            "resolve either.\n\n"
            "**Undefined identifiers in reachable code.** The same file built a transaction from "
            "`TransactionBuilder`, `Operation`, `Asset`, `Memo` and `NETWORK_PASSPHRASE` — none of the five "
            "imported. Every donation submission threw a `ReferenceError`."
        ),
        hard=(
            "**Type information.** Recognising that a value came from a `NUMERIC` column, or that "
            "`response.data` has already been unwrapped, needs more than a syntax tree. Deciding how much "
            "type awareness each rule needs — and paying for it in hook latency — is the central trade-off.\n\n"
            "**False positives are fatal.** A rule that fires on legitimate code gets disabled, and then it "
            "protects nothing. Each rule needs a corpus of true and false positives drawn from this "
            "repository's real history, not invented examples.\n\n"
            "**Fixers must preserve behaviour.** Rewriting `parseFloat` on a monetary value is not a "
            "mechanical substitution — it changes the type flowing downstream. Some rules will warrant a fixer "
            "and some will only warrant a diagnostic, and being honest about which is which matters.\n\n"
            "**Cross-language.** The same classes exist in the Rust contracts and the Go scheduler. Whether "
            "this pack covers them or stays JavaScript-only is a scoping decision to make explicitly."
        ),
        approach=(
            "Build a real plugin with a rule-testing harness, per-rule documentation explaining the defect "
            "each one prevents, and a severity policy separating what blocks a commit from what only warns.\n\n"
            "Seed each rule's test corpus from the actual commits that introduced the bug, so the rule is "
            "demonstrably capable of catching the thing it was written for.\n\n"
            "Roll out with a baseline rather than a big-bang cleanup — 98 `parseFloat` call sites cannot be "
            "converted in one change, and pretending otherwise stalls the whole effort."
        ),
        acceptance=[
            "A lint plugin ships with a rule-test harness and per-rule documentation naming the defect it prevents.",
            "A money rule flags `parseFloat` and `Number()` applied to values originating in a `NUMERIC` column.",
            "An envelope rule flags reads at the wrong depth for responses the interceptor has already unwrapped.",
            "An import rule flags unresolvable relative imports and cross-package boundary violations.",
            "A rule flags identifiers used in reachable code but never imported or defined.",
            "Each rule's tests include true positives taken from the commits that actually introduced the bug, plus false-positive cases that must not fire.",
            "Fixers, where provided, are proven behaviour-preserving; rules without a safe fix ship diagnostic-only and say so.",
            "A baseline lets the pack be adopted without converting all 98 existing `parseFloat` sites at once.",
            "The pack runs from the pre-commit gate within the documented latency budget.",
        ],
        scope=(
            "Roughly **3,000–5,000 lines**: plugin scaffolding, eight to twelve rules with fixers where safe, "
            "a rule-test harness, per-rule documentation, the baseline mechanism, and test corpora drawn from "
            "real history."
        ),
        files=[
            "backend/.eslintrc.json",
            "frontend/.eslintrc.json",
            "backend/src/db/schema.sql",
            "frontend/lib/api.ts",
            "mobile/app/donate/[id].tsx",
        ],
    ),

    # ─────────────────────────────────────────────────────────────────────────
    B(
        area="Infra",
        label="area: infra",
        title="Enforce commit, branch and naming policy in one implementation used by hooks and CI",
        summary=(
            "`semantic-release` is configured with `@semantic-release/commit-analyzer`, so **commit messages "
            "already decide version bumps and changelog contents** — and nothing validates them. A malformed "
            "or mis-typed commit silently produces the wrong release. Separately, `CLAUDE.md` sets naming "
            "rules for branches, commits, files, identifiers and comments, and nothing enforces those either.\n\n"
            "Build one policy implementation and drive it from a `commit-msg` hook, a `pre-push` branch check, "
            "and a CI check on pull request titles, so local and remote cannot disagree."
        ),
        evidence=(
            "```json\n"
            "// .releaserc.json — commit messages drive releases\n"
            "\"plugins\": [\n"
            "  \"@semantic-release/commit-analyzer\",\n"
            "  \"@semantic-release/release-notes-generator\",\n"
            "  \"@semantic-release/changelog\", ...\n"
            "```\n\n"
            "```\n"
            "$ grep -rln 'commitlint' --include=package.json .   → nothing\n"
            "$ ls .husky                                          → does not exist\n"
            "```\n\n"
            "`CLAUDE.md` states that model-related terms must not appear in branch names, commit messages, "
            "pull request titles and descriptions, file and directory names, code identifiers, or comments. "
            "Nothing in `.github/workflows/` or `scripts/` checks any of that.\n\n"
            "With 200 issues open and contributions arriving from many first-time contributors, this is "
            "enforced entirely by reviewer attention today."
        ),
        hard=(
            "**One implementation, three call sites.** The `commit-msg` hook runs offline against a file on "
            "disk; the CI check runs against a pull request title through the API, where the title is what "
            "gets squash-merged and the individual commits may not be. Sharing logic across those without it "
            "drifting is the main design problem.\n\n"
            "**Commits you must not reject.** Merge commits, reverts, `fixup!` and `squash!` commits, and "
            "semantic-release's own `chore(release):` commits all have to pass. Getting this wrong makes the "
            "hook infuriating within a day.\n\n"
            "**Scope validation.** A conventional-commit scope should name something real — a workspace or a "
            "known area — and that list has to be derived from the repository rather than hardcoded, or it "
            "goes stale the first time a workspace is added.\n\n"
            "**Naming rules need care.** A substring ban produces false positives on ordinary words; word-"
            "boundary matching on identifiers, paths and prose each behave differently. The rule has to be "
            "precise enough that contributors trust it.\n\n"
            "**Failure messages are the product.** A rejected commit must say what is wrong and show a "
            "corrected example. A bare non-zero exit teaches nothing and trains people to use `--no-verify`."
        ),
        approach=(
            "Write the policy as a library with no I/O: given a message, a branch name and a file list, "
            "return structured violations. Wrap it in three thin adapters for the hook, the pre-push check "
            "and the CI job.\n\n"
            "Derive valid scopes from the workspaces actually present. Cover the naming rules from `CLAUDE.md` "
            "with word-boundary matching tuned separately for identifiers, paths and prose.\n\n"
            "Since commit messages already drive releases, add a check that the computed next version matches "
            "what the commits on a branch imply, so an accidental `feat:` on a patch-only change is caught "
            "before it ships a minor release."
        ),
        acceptance=[
            "One policy library backs the `commit-msg` hook, the `pre-push` branch check and a CI pull-request check.",
            "Conventional-commit format is enforced, with scopes derived from the workspaces present rather than hardcoded.",
            "Merge, revert, `fixup!`, `squash!` and `chore(release):` commits are accepted, each covered by a test.",
            "The naming rules from `CLAUDE.md` are enforced for branch names, commit messages, pull request titles and added file paths.",
            "Word-boundary matching is tuned per context so ordinary words containing a banned substring do not trip the check.",
            "Every rejection prints what was wrong and a corrected example of the same message.",
            "The pull-request title is checked in CI, because that is what a squash merge records.",
            "A check reports the version bump the branch's commits imply, so an unintended bump is visible before release.",
            "Bypassing locally is possible but recorded, and CI re-checks independently.",
        ],
        scope=(
            "Roughly **3,000–4,000 lines**: the policy core, three adapters, scope derivation, the naming "
            "rules with per-context matching, version-bump reporting, message rendering, and the test matrix "
            "covering the commit shapes that must not be rejected."
        ),
        files=[
            "CLAUDE.md",
            ".releaserc.json",
            ".husky/ (new)",
            ".github/workflows/ci.yml",
        ],
    ),
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--sleep", type=float, default=1.2)
    args = parser.parse_args()

    print(f"Repo: {REPO}\nIssues defined: {len(ISSUES)}")

    titles = [f"{i['area']}: {i['title']}" for i in ISSUES]
    if len(set(titles)) != len(titles):
        dupes = {t for t in titles if titles.count(t) > 1}
        print(f"ERROR: duplicate titles within this batch: {dupes}", file=sys.stderr)
        sys.exit(1)

    print("Fetching existing issue titles (so nothing is duplicated)...")
    already = existing_titles()
    print(f"  {len(already)} issues already in the tracker — these will be left untouched.")

    created = skipped = 0
    for i, issue in enumerate(ISSUES):
        full = f"{issue['area']}: {issue['title']}"
        if full in already:
            print(f"  [{i}] skip (already exists): {full}")
            skipped += 1
            continue
        print(f"  [{i}] {full}")
        create_issue(issue, dry_run=args.dry_run)
        created += 1
        if not args.dry_run:
            time.sleep(args.sleep)

    print(f"\nDone. Created: {created}, skipped as existing: {skipped}")


if __name__ == "__main__":
    main()
