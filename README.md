# Pinocchio

Pinocchio checks claims in public web app documentation with Kane CLI. It quotes the original claim, runs the browser check against the app, and records screenshots and questioning rounds. The local report shows Kane's outcomes alongside Pinocchio's verdicts.

## Quick start

Use Node.js 20.12 or newer with Git, Docker, Kane CLI, and a Gemini API key. Start Docker and put `GEMINI_API_KEY` in `.env` in the directory where you run Pinocchio. Use a Gemini project on the free tier.

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

## Try the local npm package

```sh
npm pack
npx --package ./pinocchio-0.0.0.tgz -- pinocchio --help
```

The package includes the compiled CLI and the Linkding target. Run `pinocchio check sissbruecker/linkding` from the directory that contains your `.env` when using the installed command.

## What the evidence means

Gemini extracts claims from the selected documentation, so use public source material. Kane executes the browser checks and records step screenshots. Pinocchio can then question a failure and run a control. A confirmed outdated verdict requires two distinct Kane failures of the documented assertion, a passing control that rules out a test mistake, and historical evidence of the old behavior. Claims with insufficient evidence stay unconfirmed.

The verified Linkding example checks an old instruction to click an Admin tab within Settings. Two independent runs found no in-page tab. A third run used the same account to find the Admin item in the top navigation's Settings dropdown and open Site administration. The control evidence overruled Kane's account diagnosis. After a documentation patch described the dropdown route, a fresh Kane run passed that route.

Linkding's Admin-tab claim currently has a reviewed questioning flow. Other checks retain Kane's individual browser outcomes and use an unconfirmed claim verdict until a reviewed flow covers them. Use `report` on saved checks to render evidence without calling Gemini or Kane again.

## Development checks

```sh
npm test
npm run typecheck
```

The test suite includes a readiness check on the loopback interface. The live Gemini extraction test runs only when `PINOCCHIO_LIVE=1` is set.
