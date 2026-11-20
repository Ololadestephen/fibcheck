# fibcheck

fibcheck is a lie detector for READMEs and docs. It reads a web app's documentation, picks the claims a browser can test, and has [Kane CLI](https://www.npmjs.com/package/@testmuai/kane-cli) check each one in a real browser against the running app. Every result is kept with Kane's step screenshots, and nothing is called wrong until Kane has failed it twice, a control has passed, and a person has read the evidence.

Built for the Kane CLI Hackathon, with Claude Code.

## What it found

- **[The fibcheck index](index/README.md):** 8 popular self-hosted web apps checked. 0 of 17 README claims were false. In their docs pages and wikis, 4 wrong or stale instructions were confirmed across 3 projects (Linkding 2, Mealie 1, Uptime Kuma 1), each with two failing Kane runs, a passing control and screenshots. For three of them, Kane also passed a fresh run that followed the corrected wording.
- **A fix merged upstream:** Mealie's maintainers merged our docs fix ([mealie-recipes/mealie#9212](https://github.com/mealie-recipes/mealie/pull/9212)). A docs PR to Linkding is open, and a note is on the Uptime Kuma issue about the same menu.
- **Live on pull requests:** in [this demo pull request](https://github.com/Ololadestephen/fibcheck/pull/1), the GitHub Action started Linkding in Docker on GitHub's free runner, Kane failed an outdated "Admin tab" step twice while the control passed, and the comment flagged the line for review ([run log and screenshots](https://github.com/Ololadestephen/fibcheck/actions/runs/44762871602)).
- **Share cards** for each finding are in [index/cards](index/cards), drawn from Kane's own screenshots.

## How it works

1. **Read and rank.** fibcheck's agent reads the README and docs, quotes each claim a browser can test, and ranks the most specific first: named menus, tabs, buttons and settings, defaults, shortcuts and step-by-step instructions, because those go stale when an interface changes.
2. **Write the check.** For each claim it writes a Kane check: browser steps and explicit assertions. A claim that names a tab, menu, button, link or dropdown must start with an assertion of that exact label, in the place the docs name.
3. **Run Kane.** `kane-cli run` executes the check in a real browser. Kane alone decides whether the run passed or failed; fibcheck reads its NDJSON result, steps and evidence pack.
4. **Question the result.** The agent reads Kane's run and says whether it really tested the claim as written. A pass through a different menu does not count. A failure is reproduced in a separate run, and a control that should pass rules out a test mistake. Kane's own blame label is a hypothesis, overruled with evidence when the screenshots disagree.
5. **A person decides.** Two failures, a reason the test was not at fault, and a passing control make a candidate finding. A person reads the screenshots before anything is called false or outdated.
6. **Attack the fix.** Before a docs fix is suggested, an attacking agent tries the shortcuts a hurried editor might take, and each one must be rejected (see [below](#the-attacking-agent)).

fibcheck's agent runs on Google Gemini by default, or on any OpenAI-compatible model you choose. Kane CLI is the only judge of whether a browser run passed.

## For judges

There are three ways to try fibcheck:

1. **With the judges' Gemini key.** The submission form includes a Gemini API key for judging. It is never in this repository. Put it in `.env` as `GEMINI_API_KEY=...` and follow the quick start. Kane CLI needs your own TestMu AI account (`kane-cli login`).
2. **With your own model.** Set `FIBCHECK_MODEL_BASE_URL`, `FIBCHECK_MODEL_API_KEY` and `FIBCHECK_MODEL` as shown in [Use your own model](#use-your-own-model), then follow the quick start.
3. **With no keys at all.** After `npm ci && npm run build`, run `node dist/cli.js report examples/sample-check/check.json`. It rebuilds `report.html` and `badge.svg` from a real saved check, without calling Kane or any model: the Linkding check that found the outdated Admin tab step, with both failing Kane runs, the passing control and their 55 step screenshots. The [fibcheck index](index/README.md) links every other claim to its screenshots.

## Quick start

Use Node.js 20.12 or newer with Git, Docker, Kane CLI, and a model for fibcheck's agent. Start Docker and put `GEMINI_API_KEY` in `.env` in the directory where you run fibcheck (use a Gemini project on the free tier), or choose another model as described in [Use your own model](#use-your-own-model).

```sh
npm install -g @testmuai/kane-cli
kane-cli login --oauth
npm ci
npm run build
node dist/cli.js check sissbruecker/linkding --max-claims 1
```

The check prints the path to its `check.json`. Pass that path to `report` to write `report.html` and `badge.svg` beside it.

```sh
node dist/cli.js report runs/REPLACE_WITH_RUN_ID/check.json
```

The Linkding GitHub clone URL also selects the bundled target. For another public web app, create a target JSON describing its repository, Docker image, port, and any login steps. Use `targets/linkding.json` as an example and pass your file to `check`. `--only` selects a claim by ID. fibcheck ranks the testable claims by how specific they are: named menus, tabs, buttons and settings, default values, shortcuts and step-by-step instructions come first, because those are the lines that go stale when an interface changes. The top `--max-claims` claims are tested (5 by default; 5 to 10 is a good range), and the rest are listed in the report as not tested, in ranked order, with the reasons for each score in `check.json`.

To check an app that is already running somewhere, with no Docker, pass its address with `--url`. Use `--login` to describe your own sign-in, writing `{{NAME}}` for each value, and put the values in `.env` as `FIBCHECK_LOGIN_NAME=...`. They are passed to Kane as secret variables and are never sent to Gemini.

```sh
node dist/cli.js check sissbruecker/linkding --url https://bookmarks.example.org \
  --login "If the login form is shown, sign in as {{user}} with password {{pass}}." --max-claims 2
```

Use `--max-kane-runs 12` to cap Kane invocations per check, including retries and controls. If the budget runs out before a required follow-up, the claim stays unconfirmed. The report lists claims that were never started. Use `--max-kane-runs 0` to extract claims without starting the app or Kane.

## Commands

| Command | What it does |
|---|---|
| `fibcheck check <target.json \| repository>` | Reads the docs, ranks the claims and runs the top ones with Kane. Options: `--max-claims`, `--max-kane-runs`, `--only`, `--url`, `--login` |
| `fibcheck report <check.json>` | Writes `report.html` and `badge.svg` from a saved check, without calling Kane or any model |
| `fibcheck freeze <docs.md> --out <claims.json>` | Writes the checks for a docs file once, for a person to review and commit (see [frozen checks](#check-docs-changes-in-github-actions)) |
| `fibcheck attack <finding-id> --url ADDRESS` | Tries lazy fixes for a recorded finding against the running app |
| `fibcheck card <finding-id \| --all>` | Draws a share card for a recorded finding from its verdict and Kane screenshot |

Before npm publishing, run them as `node dist/cli.js <command>` after `npm run build`.

## Use your own model

Gemini's free tier is the default. To use any OpenAI-compatible model instead, set three values in `.env`. fibcheck then uses that model for every step, and no Gemini key is needed.

```sh
# OpenAI
FIBCHECK_MODEL_BASE_URL=https://api.openai.com/v1
FIBCHECK_MODEL_API_KEY=sk-...
FIBCHECK_MODEL=gpt-4.1-mini

# NEAR AI Cloud
FIBCHECK_MODEL_BASE_URL=https://cloud-api.near.ai/v1
FIBCHECK_MODEL_API_KEY=...
FIBCHECK_MODEL=google/gemini-2.5-flash-lite

# OpenRouter
FIBCHECK_MODEL_BASE_URL=https://openrouter.ai/api/v1
FIBCHECK_MODEL_API_KEY=sk-or-...
FIBCHECK_MODEL=meta-llama/llama-3.3-70b-instruct

# A local Ollama model (no key needed on this machine)
FIBCHECK_MODEL_BASE_URL=http://localhost:11434/v1
FIBCHECK_MODEL=qwen3:8b
```

Use one block at a time. The model must support JSON output; a model that cannot follow the JSON format leaves claims unconfirmed rather than guessing.

The same call limits apply to every model (`FIBCHECK_MAX_CALLS_PER_RUN`, 60 by default, and `FIBCHECK_MAX_CALLS_TOTAL`, 1,500), and every call is recorded in `.fibcheck/usage-ledger.jsonl` without its prompt. If you know the model's prices, add them in dollars per million tokens, and fibcheck enforces a dollar cap across all runs (1 dollar unless `FIBCHECK_MODEL_MAX_USD` says otherwise):

```sh
FIBCHECK_MODEL_PRICE_INPUT=0.4
FIBCHECK_MODEL_PRICE_OUTPUT=1.6
FIBCHECK_MODEL_MAX_USD=0.5
```

Without prices, only the call cap limits use, and the report says that the dollar cost was not tracked. If the model's reply is not usable JSON, that part of a document gives no claims, or the claim stays unconfirmed, and the report lists it. Unusable output never makes a claim false.

## Try the local npm package

```sh
npm pack
npx --package ./fibcheck-0.0.0.tgz -- fibcheck --help
```

The package is not on npm yet. Once it is published, `npx fibcheck check sissbruecker/linkding` will run the same command. The package includes the compiled CLI and the Linkding target. Run `fibcheck check sissbruecker/linkding` from the directory that contains your `.env` when using the installed command.

## Check docs changes in GitHub Actions

The [example workflow](examples/readme-check.yml) checks a docs file (the root `README.md` by default, or any Markdown file set with `docs-file`) in same-repository pull requests on public GitHub repositories. It runs on GitHub's free `ubuntu-latest` runner, which has Docker and Chrome. It reads the docs file at the PR head commit, as text, and the target JSON at the trusted base commit. The browser checks exercise the Docker image configured in that base target. [GitHub Actions security guidance](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target)

1. Add repository secrets `GEMINI_API_KEY`, `LT_USERNAME` and `LT_ACCESS_KEY` (your TestMu AI username and access key), and repository variables `KANE_PROJECT_ID` and `KANE_FOLDER_ID` (from `kane-cli config show`). The Action installs Kane CLI, signs in with them, and writes the model key to a private `.env` outside the workspace.
2. Add `.github/fibcheck.target.json` to the base branch, using `targets/linkding.json` as a shape example. Set the image and port for the public app you want to check.
3. Copy the example into `.github/workflows/` in the consumer repository and pin the `uses:` line to the approved fibcheck commit. Set `FIBCHECK_PR_COMMENTS` to `true` to enable the separate comment job.

**Frozen checks (recommended).** The model writes a slightly different check each time it reads a sentence, so a pull request check can pass one day and not the next. To avoid that, generate the checks once with `fibcheck freeze <docs.md> --out <claims.json>`, read each one, fill in its `reviewed` field, and commit the file to the base branch. Pass it as `claims-file`: the Action then runs exactly those checks and never writes new ones in CI. If a pull request changes a line that has a frozen check, or a check was edited after review, the comment lists it under "Needs review" and Kane does not run it. Every check for a sentence that names a tab, menu, button, link or dropdown must start with an exact-label assertion (for example "the Settings page content shows a tab labelled 'Admin'"); fibcheck does not run a check without one.

This repository runs the same Action on its own [demo docs page](examples/linkding-demo/README.md) with [this workflow](.github/workflows/docs-check.yml): a pull request that changes the page starts Linkding in Docker, checks the page with Kane, and posts the result.

The comment lists counts, a row per checked line with its result and every Kane run, and the line numbers a person should review: a line Kane failed twice while a control passed, or a line whose behaviour held under different visible wording. It never calls a line false on its own. The job log prints every Kane run's steps and observations, with test passwords and local paths removed. Set `evidence-artifact: 'true'` to upload Kane's step screenshots as a workflow artifact for 7 days; on a public repository any signed-in GitHub user can download it. Otherwise the raw Kane output stays in the runner's temporary directory and is deleted with the runner. On a dedicated self-hosted runner, pass `env-file` (an absolute path to a private `.env` outside the workspace) with Kane CLI already signed in, instead of the key and sign-in inputs. [GitHub comment permissions](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment)

## The attacking agent

A failing check can be made to pass without fixing anything. Before fibcheck suggests a docs fix, its attacker plays a hurried editor and proposes four shortcuts: delete the line, make it vague, hedge it ("usually at the top left"), or swap in a confident wrong detail. Each must be rejected. Deletions, vaguer lines and hedges are rejected by fixed rules: they have fewer checkable details than the proven fix. A wrong detail goes to Kane, and it only counts as rejected when Kane fails it in the exact place it names.

On the four index findings, all 12 delete, vague and hedge attempts were rejected. The 4 wrong-detail attempts stay "can't tell": Kane failed them, but none of those runs tested the wrong sentence in the place it names, so none is counted. Every attempt is recorded in [index/attacks](index/attacks), and the index explains [what we learned](index/README.md#lazy-fixes-we-tried-and-rejected).

## What the evidence means

fibcheck's agent (Gemini by default, or your chosen model) extracts claims from the selected documentation, so use public source material. Kane executes the browser checks and records step screenshots. fibcheck can then question a failure and run a control. A confirmed outdated verdict requires two distinct Kane failures of the documented assertion, a passing control that rules out a test mistake, and historical evidence of the old behavior. Claims with insufficient evidence stay unconfirmed.

The verified Linkding example checks an old instruction to click an Admin tab within Settings. Two independent runs found no in-page tab. A third run used the same account to find the Admin item in the top navigation's Settings dropdown and open Site administration. The control evidence overruled Kane's account diagnosis. After a documentation patch described the dropdown route, a fresh Kane run passed that route.

Linkding's Admin-tab and tag-management claims have hand-reviewed flows. Every other claim goes through the general diagnosis. After each Kane run, the model reads the claim and Kane's result, says whether the run tested the claim as written, and names the likely cause of a failure: a Kane misstep, a wrong check, a setup problem, something Kane cannot do, or a real contradiction. It can reword the check once, except for frozen checks, which run exactly as reviewed with their reviewed control. When two separate Kane failures both read as contradictions, with a written reason the test was not at fault and a passing control, the claim becomes a candidate finding. It stays unconfirmed until a person who has read the evidence decides; fibcheck never calls a claim false on its own. The general diagnosis never reports "outdated", because it does not check the project's history. Each claim uses at most 4 Kane runs. Without `--max-kane-runs`, a check is capped at 4 runs per tested claim. If the model is unavailable or its reply is unusable, the claim stays unconfirmed. Where the model disagrees with Kane's own blame label, the report shows the override and its evidence.

Only public material goes to the model: the documentation text, the claim, and a summary of Kane's result. Test passwords, local and private addresses, the address of the app under test, file paths and Kane session links are removed before sending. Public example addresses such as https://example.com are kept, because checks type them into forms. On Gemini's free tier, Google may use that content to improve its products. If `NEAR_AI_API_KEY` is set, the same public content goes to NEAR AI Cloud (model `google/gemini-2.5-flash-lite`) only when Gemini refuses or is overloaded, with a hard $0.20 spending cap.

Use `report` on saved checks to render evidence without calling any model or Kane again.

## Development checks

```sh
npm test
npm run typecheck
```

The tests run offline with no keys. The suite includes a readiness check on the loopback interface. The live Gemini extraction test runs only when `FIBCHECK_LIVE=1` is set. Code quality is also scanned with Desloppify.
