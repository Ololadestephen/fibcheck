# fibcheck

fibcheck is a lie detector for READMEs. It checks claims in public web app documentation with Kane CLI. It quotes the original claim, runs the browser check against the app, and records screenshots and questioning rounds. The local report shows Kane's outcomes alongside fibcheck's verdicts.

**[The fibcheck index](index/README.md):** 8 popular self-hosted web apps checked on November 17, 2026. 17 README claims tested, 16 held, 1 unconfirmed, 0 confirmed false or outdated, with a screenshot for every claim.

## Quick start

Use Node.js 20.12 or newer with Git, Docker, Kane CLI, and a Gemini API key. Start Docker and put `GEMINI_API_KEY` in `.env` in the directory where you run fibcheck. Use a Gemini project on the free tier.

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

The Linkding GitHub clone URL also selects the bundled target. For another public web app, create a target JSON describing its repository, Docker image, port, and any login steps. Use `targets/linkding.json` as an example and pass your file to `check`. `--only` selects a claim by ID, and `--max-claims` limits the number of claims checked.

Use `--max-kane-runs 12` to cap Kane invocations per check, including retries and controls. If the budget runs out before a required follow-up, the claim stays unconfirmed. The report lists claims that were never started. Use `--max-kane-runs 0` to extract claims without starting the app or Kane.

## Try the local npm package

```sh
npm pack
npx --package ./fibcheck-0.0.0.tgz -- fibcheck --help
```

The package is not on npm yet. Once it is published, `npx fibcheck check sissbruecker/linkding` will run the same command. The package includes the compiled CLI and the Linkding target. Run `fibcheck check sissbruecker/linkding` from the directory that contains your `.env` when using the installed command.

## Check README changes in GitHub Actions

The [example workflow](examples/readme-check.yml) checks root `README.md` changes in same-repository pull requests on public GitHub repositories. It reads the README at the PR head commit and the runtime target JSON at the trusted base commit. The browser checks exercise the Docker image configured in that base target. [GitHub Actions security guidance](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target)

1. Use an isolated, ephemeral self-hosted runner labelled `fibcheck`, with Node.js, npm, Docker, a supported browser, and Kane CLI already authenticated. Put the Gemini key in a private `.env` outside the workflow workspace. Set `FIBCHECK_RUNNER_ENV_FILE` to its absolute path.
2. Add `.github/fibcheck.target.json` to the base branch, using `targets/linkding.json` as a shape example. Set the image and port for the public app you want to check.
3. Copy the example into `.github/workflows/` in the consumer repository and pin the `uses:` line to the approved fibcheck commit. Set `FIBCHECK_PR_COMMENTS` to `true` to enable the separate comment job.

The check job writes a counts-only summary. The comment job can post that summary with PR write permission. The check writes the raw Kane output and screenshots to a private directory beside the runner's `.env`. Keep that directory on private storage if you need to retain the evidence after the runner shuts down. [GitHub comment permissions](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment)

## What the evidence means

Gemini extracts claims from the selected documentation, so use public source material. Kane executes the browser checks and records step screenshots. fibcheck can then question a failure and run a control. A confirmed outdated verdict requires two distinct Kane failures of the documented assertion, a passing control that rules out a test mistake, and historical evidence of the old behavior. Claims with insufficient evidence stay unconfirmed.

The verified Linkding example checks an old instruction to click an Admin tab within Settings. Two independent runs found no in-page tab. A third run used the same account to find the Admin item in the top navigation's Settings dropdown and open Site administration. The control evidence overruled Kane's account diagnosis. After a documentation patch described the dropdown route, a fresh Kane run passed that route.

Linkding's Admin-tab and tag-management claims have hand-reviewed flows. Every other claim goes through the general diagnosis. After each Kane run, Gemini reads the claim and Kane's result, says whether the run tested the claim as written, and names the likely cause of a failure: a Kane misstep, a wrong check, a setup problem, something Kane cannot do, or a real contradiction. It can reword the check once. A claim becomes false only after two separate Kane failures that both read as contradictions, a written reason the test was not at fault, and a passing control. The general diagnosis never reports "outdated", because it does not check the project's history. Each claim uses at most 4 Kane runs within the `--max-kane-runs` cap. If Gemini is unavailable, the claim stays unconfirmed. Where Gemini disagrees with Kane's own blame label, the report shows the override and its evidence.

Only public material goes to Gemini: the documentation text, the claim, and a summary of Kane's result. Test passwords, URLs, local hosts and paths, and Kane session links are removed before sending. On Gemini's free tier, Google may use that content to improve its products.

Use `report` on saved checks to render evidence without calling Gemini or Kane again.

## Development checks

```sh
npm test
npm run typecheck
```

The test suite includes a readiness check on the loopback interface. The live Gemini extraction test runs only when `FIBCHECK_LIVE=1` is set.
