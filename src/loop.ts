import { normalise } from "./claims/quotes.js";
import type { Claim } from "./claims/types.js";
import type { KaneRun } from "./kane/runner.js";
import { distinctKaneRuns, type StepEvidence } from "./kane/evidence.js";
import { questionGenerally, type GeneralQuestioning } from "./general-loop.js";
import { linkdingTagClaim, questionLinkdingTags } from "./linkding-tags.js";
import { KANE_RUN_LIMIT_REASON, type ClaimVerdict, type QuestionedRun, type Questioning, type RunRound } from "./loop-types.js";
import { isLinkdingRepo, type Target } from "./target.js";

const ADMIN_TAB_QUOTE = "to open the admin app, go the settings view and click on the admin tab";
const ADMIN_DOC = "docs/src/content/docs/admin.md";
const SETTINGS_PATH = "/settings/general";
const ADMIN_PATH = "/admin/";
const READY_ASSERTION = "The Settings page shows the Profile form.";
const READY_WITH_SAVE = "The Settings page shows the Profile form and its Save button.";
const TAB_ASSERTION = "The Settings page contains an in-page Admin tab.";
const MENU_ASSERTION = "The Settings dropdown contains an Admin menu item.";
const TITLE_ASSERTION = "The administration page title contains Site administration.";
const ACCOUNT_ASSERTION = "The Site administration dashboard shows the account pinotest.";
const USERS_ASSERTION = "The Site administration dashboard shows a Users link.";
const CHECK_TAB = `Open ${SETTINGS_PATH} after login and wait for it to load. First assert exactly: ${READY_ASSERTION} Expect true. Use visual inspection and check tabs implemented as links as well as native tabs. Assert exactly: ${TAB_ASSERTION} Expect true. Ignore the top navigation dropdown. If the assertion fails, stop there. If it passes, click the in-page Admin tab and assert that the administration page title contains Site administration.`;
const RETRY_TAB = `Go directly to ${SETTINGS_PATH} after login. First assert exactly: ${READY_ASSERTION} Expect true. Independently inspect the visible navigation inside the Settings page content and look for an Admin tab, including links styled as tabs. Reuse this exact boolean assertion: ${TAB_ASSERTION} Expect true. Capture the failed assertion if there is no tab. If present, click the in-page Admin tab and verify the Site administration page title.`;
const CONTROL = `From the signed-in bookmarks page, open the Settings dropdown in the top navigation. Assert exactly: ${MENU_ASSERTION} Expect true. Click Admin inside that dropdown. Make these as separate assertions: ${TITLE_ASSERTION} ${ACCOUNT_ASSERTION} ${USERS_ASSERTION} Expect true for each.`;
const CONTROL_PROOF = "The same test login opened Site administration through the top navigation’s Settings dropdown in the passing control run.";
const TAB_HISTORY = "Linkding’s historical source had an Admin tab in the Settings template at 3ae9cf0. The template was removed at 226eb69.";

export async function questionClaim(
  claim: Claim,
  managedTarget: Pick<Target, "repo" | "login" | "app"> | undefined,
  originalObjective: string,
  run: RunRound,
  prepareTags?: () => Promise<void>,
  canRunFollowUp: () => boolean = () => true,
  general?: GeneralQuestioning,
): Promise<QuestionedRun> {
  // A frozen, reviewed check is run exactly as reviewed, never through a built-in special case.
  if (general?.frozen && claim.check) return await questionGenerally(claim, claim.check, general, run, canRunFollowUp);
  const linkding = managedTarget && isLinkdingRepo(managedTarget.repo)
    && managedTarget.app?.image === "sissbruecker/linkding:1.47.0"
    && managedTarget.app?.env?.LD_SUPERUSER_NAME === "pinotest"
    && managedTarget.app?.env?.LD_SUPERUSER_PASSWORD === "{{secret:app_pass}}"
    && managedTarget.login?.includes("pinotest and password {{app_pass}}");
  if (linkding && managedTarget.login && prepareTags) {
    const tags = linkdingTagClaim(claim);
    if (tags) {
      await prepareTags();
      return questionLinkdingTags(tags, managedTarget.login, run, canRunFollowUp);
    }
  }
  if (!linkding || !isAdminTabClaim(claim)) {
    if (general && claim.check) return await questionGenerally(claim, claim.check, general, run, canRunFollowUp);
    const kane = await run("initial", originalObjective);
    return {
      kane,
      questioning: {
        verdict: "unconfirmed",
        reason: "This claim has no reviewed check for verifying that Kane exercised the documented behavior.",
        initialReason: "Run the browser check extracted from the documentation.",
        followUps: [],
        overrides: [],
      },
    };
  }

  const initialReason = "Verify that Settings loaded, then look for the tab inside the page before following it.";
  const followUps: Questioning["followUps"] = [];
  const kane = await run("initial", withLogin(managedTarget.login, CHECK_TAB), "visual");
  const outcome = (verdict: ClaimVerdict, reason: string, overrides: Questioning["overrides"] = []) => ({
    kane,
    questioning: { verdict, reason, initialReason, followUps, overrides },
  });

  if (tabPresent(kane)) return outcome("true", "Kane observed the in-page Admin tab and verified the administration page.");
  if (!tabAbsent(kane)) {
    return outcome("unconfirmed", "Kane did not establish the result of the in-page Admin tab assertion on the Settings page.");
  }

  if (!canRunFollowUp()) return outcome("unconfirmed", KANE_RUN_LIMIT_REASON);
  const retry = await run("retry", withLogin(managedTarget.login, RETRY_TAB), "visual");
  followUps.push({ purpose: "retry", reason: "Repeat the in-page tab assertion in a separate run with the same logged-in account.", kane: retry });
  if (tabPresent(retry)) {
    return outcome("unconfirmed", "The two Kane runs disagreed about the in-page Admin tab.");
  }
  if (!tabAbsent(retry) || !distinctKaneRuns(kane, retry)) {
    return outcome("unconfirmed", "Kane did not reproduce the same failed tab assertion in two distinct runs.");
  }

  if (!canRunFollowUp()) return outcome("unconfirmed", KANE_RUN_LIMIT_REASON);
  const control = await run("control", withLogin(managedTarget.login, CONTROL));
  followUps.push({ purpose: "control", reason: "Check whether this account can reach the admin dashboard through the Settings dropdown.", kane: control });
  if (!menuControlPassed(control) || !distinctKaneRuns(control, kane) || !distinctKaneRuns(control, retry)) {
    return outcome("unconfirmed", "The control did not establish that the same login could access Site administration.");
  }

  const overrides = [testDataOverride("initial", kane), testDataOverride("retry", retry)]
    .filter((entry) => entry !== undefined);
  return outcome("outdated", `Two separate Kane runs found no Admin tab inside the Settings page. ${CONTROL_PROOF} ${TAB_HISTORY}`, overrides);
}

function isAdminTabClaim(claim: Claim): boolean {
  if (claim.type !== "ui_flow" || claim.source.file !== ADMIN_DOC) return false;
  const quote = normalise(claim.quote).replace(/\.$/, "");
  return quote === ADMIN_TAB_QUOTE || quote === "go the settings view and click on the admin tab";
}

function withLogin(login: string | undefined, objective: string): string {
  return [login, objective].filter(Boolean).join(" ");
}

function tabAbsent(run: KaneRun): boolean {
  const assertionFailure = ["assertion_error.final_verification", "assertion_error.checkpoint_failed"].includes(run.reasonCode);
  return run.status === "failed" && assertionFailure
    && Boolean(run.failedStep && isTabAssertion(run.failedStep.remark))
    && tabAssertionOnReadyPage(run, "failed")
    && tabObservation(run, "false");
}

function tabPresent(run: KaneRun): boolean {
  return run.status === "passed"
    && tabAssertionOnReadyPage(run, "passed")
    && tabObservation(run, "true")
    && clickedAdmin(run, /^click:(?!.*\b(?:dropdown|menu)\b).*\badmin\b.*\btab\b/)
    && adminPageVerified(run);
}

function tabAssertionOnReadyPage(run: KaneRun, status: "failed" | "passed"): boolean {
  const ready = assertionText(READY_ASSERTION);
  if (!observedTrue(run, ready)) return false;
  const assertions = screenshotsAt(run, SETTINGS_PATH).filter((step) => step.kind === "assert");
  const readinessSummaries = [ready, assertionText(READY_WITH_SAVE)];
  const readyStep = assertions.find((step) => step.status === "passed" && readinessSummaries.includes(assertionText(step.summary)));
  return Boolean(readyStep && assertions.some((step) => step.ordinal > readyStep.ordinal && step.status === status && isTabAssertion(step.summary)));
}

function isTabAssertion(text: string): boolean {
  const condition = assertionText(text);
  return condition === "the settings page contains an in-page admin tab"
    || condition === "the settings page has a tab named admin";
}

function tabObservation(run: KaneRun, value: "true" | "false"): boolean {
  const observations = run.observations.filter((observation) => isTabAssertion(observation.condition));
  return observations.some(({ analyzerType, usedDomCode }) => /^(visual|textual_visual)$/.test(analyzerType ?? "") && usedDomCode === false)
    && observations.every((observation) => normalise(observation.expectedValue) === "true" && normalise(observation.extractedValue) === value);
}

function menuControlPassed(run: KaneRun): boolean {
  return run.status === "passed" && adminPageVerified(run) && clickedDropdownAdmin(run)
    && observedTrue(run, assertionText(MENU_ASSERTION))
    && observedTrue(run, assertionText(ACCOUNT_ASSERTION))
    && observedTrue(run, assertionText(USERS_ASSERTION));
}

function observedTrue(run: KaneRun, assertion: string): boolean {
  return run.observations.some((observation) => assertionText(observation.condition) === assertion
    && normalise(observation.expectedValue) === "true" && normalise(observation.extractedValue) === "true");
}

function assertionText(text: string): string {
  return normalise(text).replace(/^assert:\s*/, "").replace(/["'.]/g, "").replace(/\s+expect true$/, "");
}

function clickedDropdownAdmin(run: KaneRun): boolean {
  const openedDropdown = run.steps.find((step) => step.status === "done" && /^click:.*\bsettings\b.*\bdropdown\b/.test(normalise(step.remark)));
  return Boolean(openedDropdown && clickedAdmin(run, /^click:.*\badmin\b.*\bdropdown\b/, openedDropdown.step));
}

function clickedAdmin(run: KaneRun, click: RegExp, afterStep = 0): boolean {
  const clicked = run.steps.find((step) => step.status === "done" && step.step > afterStep
    && click.test(normalise(step.remark)));
  return Boolean(clicked && !run.steps.some((step) => step.step > clicked.step && /^navigate:/.test(normalise(step.remark))));
}

function adminPageVerified(run: KaneRun): boolean {
  return screenshotsAt(run, ADMIN_PATH).length > 0 && run.observations.some((observation) => {
    const expected = normalise(observation.expectedValue);
    const value = normalise(observation.extractedValue);
    const condition = assertionText(observation.condition);
    return (expected === "site administration" && value.startsWith("site administration"))
      || (expected === "true" && value === "true" && /^the (?:administration )?page title (?:contains|includes) site administration$/.test(condition));
  });
}

function screenshotsAt(run: KaneRun, path: string): StepEvidence[] {
  const start = new URL(run.startUrl);
  return run.evidence.filter((step) => {
    if (!step.screenshot || !URL.canParse(step.url)) return false;
    const url = new URL(step.url);
    return url.origin === start.origin && url.pathname.replace(/\/$/, "") === path.replace(/\/$/, "");
  });
}

function testDataOverride(round: "initial" | "retry", kane: KaneRun): Questioning["overrides"][number] | undefined {
  const blame = kane.blame;
  if (blame?.category !== "test_data_issue") return undefined;
  const cause = normalise(blame.rootCause);
  const missingAccess = [
    "regular user rather than an administrator",
    "account lacks administrator access",
    "account lacks admin access",
    "account does not have the required administrator access",
    "account or fixture that does not expose administrator settings",
  ].some((phrase) => cause.includes(phrase));
  const suspectedRoleMismatch = (cause.includes("account-role or test-fixture mismatch") && cause.includes("administrator access"))
    || (cause.includes("account or test expectation is mismatched") && cause.includes("pinotest login") && cause.includes("admin tab"));
  if (!missingAccess && !suspectedRoleMismatch) return undefined;
  return { round, family: blame.family, category: blame.category, hypothesis: "Kane questioned the test account’s administrator access.", evidence: CONTROL_PROOF };
}
