import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalise } from "./claims/quotes.js";
import type { Claim } from "./claims/types.js";
import { distinctKaneRuns, type StepEvidence } from "./kane/evidence.js";
import type { KaneRun } from "./kane/runner.js";
import { KANE_RUN_LIMIT_REASON, type ClaimVerdict, type QuestionedRun, type Questioning, type RunRound } from "./loop-types.js";

const MAIN_TAG = "pinocchiotag";
const ADMIN_TAG = "pinocchioadmintag";
const ADMIN_DOC = "docs/src/content/docs/admin.md";
const MAIN_LIMIT = "linkding UI currently only allows to create or assign tags";
const ADMIN_CLAIM = "you can use the admin app to manage your tags";
const ROW_PRESENT = "The ordinary Linkding Tags page lists pinocchiotag.";
const EDIT_OFFERED = "The pinocchiotag row has an Edit control on the ordinary Linkding Tags page.";
const MAIN_EDIT_NAME = "The Edit Tag Name field is pinocchiotag.";
const MAIN_RENAMED = "The ordinary Linkding Tags page lists pinocchiotagmain.";
const ADMIN_RENAMED = "The Site administration Tags list contains pinocchioadmintagproof.";
const MAIN_CONTROL_PROOF = "Kane renamed the seeded tag from the ordinary Tags page and verified the new name in the table.";
const TAG_HISTORY = "Linkding added its ordinary tag-management page in commit 82e5b7d.";

const CHECK_MAIN = `Navigate directly to /tags in the ordinary Linkding app after login. Wait for the Tags table. Assert exactly: ${ROW_PRESENT} Expect true. Look in the Actions column for that specific row. Assert exactly: ${EDIT_OFFERED} Expect false. Do not change the tag or visit the administration app.`;
const RETRY_MAIN = `After login, open the normal Linkding Tags page at /tags and wait for its table. First make this exact boolean assertion: ${ROW_PRESENT} Expect true. Now inspect only that tag's row and read the actions shown next to its name. Make this exact separate boolean assertion: ${EDIT_OFFERED} Expect false. Leave the tag unchanged.`;
const CONTROL_MAIN = `After login, open /tags in the ordinary Linkding app. Find pinocchiotag in the Tags table and click Edit in that row. Before typing, assert this exact boolean condition: ${MAIN_EDIT_NAME} Expect true. Change the Name to pinocchiotagmain and click Save in the Edit Tag form. Verify this exact condition: ${MAIN_RENAMED} Expect true. Do not use the administration app.`;
const CHECK_ADMIN = `After login, open the Settings dropdown in the top navigation, then choose Admin. On Site administration, click the Tags link in the Bookmarks section. In the admin tag list open the existing pinocchioadmintag record, change its Name to pinocchioadmintagproof, and click Save. Verify this exact condition: ${ADMIN_RENAMED} Expect true.`;
const exec = promisify(execFile);

type TagClaim = "main" | "admin";

export function linkdingTagClaim(claim: Claim): TagClaim | undefined {
  if (claim.source.file !== ADMIN_DOC || (claim.type !== "behaviour" && claim.type !== "ui_flow")) return undefined;
  const quote = normalise(claim.quote).replace(/^while /, "").replace(/[.,]$/, "");
  if (quote === normalise(MAIN_LIMIT)) return "main";
  if (quote === normalise(ADMIN_CLAIM)) return "admin";
  return undefined;
}

/** Only the managed Linkding container uses these disposable fixtures. */
export async function seedLinkdingTags(containerName: string): Promise<void> {
  const script = [
    "from django.contrib.auth import get_user_model",
    "from django.utils import timezone",
    "from bookmarks.models import Tag",
    "user = get_user_model().objects.get(username='pinotest')",
    "assert user.is_superuser and user.is_staff",
    `names = ['${MAIN_TAG}', '${ADMIN_TAG}']`,
    "assert not Tag.objects.filter(owner=user, name__in=names + ['pinocchiotagmain', 'pinocchioadmintagproof']).exists()",
    "Tag.objects.bulk_create([Tag(name=name, owner=user, date_added=timezone.now()) for name in names])",
    "assert set(Tag.objects.filter(owner=user, name__in=names).values_list('name', flat=True)) == set(names)",
  ].join("\n");
  await exec("docker", ["exec", containerName, "python", "manage.py", "shell", "-c", script]);
}

export async function questionLinkdingTags(kind: TagClaim, login: string, run: RunRound, canRunFollowUp: () => boolean): Promise<QuestionedRun> {
  if (kind === "admin") {
    const kane = await run("initial", `${login} ${CHECK_ADMIN}`, "dom");
    const verified = renamedTag(kane, "/admin/bookmarks/tag", ADMIN_TAG, "pinocchioadmintagproof", ADMIN_RENAMED);
    return {
      kane,
      questioning: {
        verdict: verified ? "true" : "unconfirmed",
        reason: verified ? "Kane renamed the seeded tag and verified the new name in the administration Tags list."
          : "Kane did not verify a saved rename in the administration Tags list.",
        initialReason: "Check the separate claim by renaming a seeded tag inside the admin app.",
        followUps: [],
        overrides: [],
      },
    };
  }

  const kane = await run("initial", `${login} ${CHECK_MAIN}`, "visual");
  const followUps: Questioning["followUps"] = [];
  const initialReason = "Verify that the seeded tag exists, then check whether its row offers Edit in the ordinary UI.";
  const outcome = (verdict: ClaimVerdict, reason: string, overrides: Questioning["overrides"] = []): QuestionedRun => ({
    kane,
    questioning: { verdict, reason, initialReason, followUps, overrides },
  });

  if (!editObservedOnFailedCheck(kane)) {
    return outcome("unconfirmed", "Kane did not establish the documented restriction for the seeded tag.");
  }

  if (!canRunFollowUp()) return outcome("unconfirmed", KANE_RUN_LIMIT_REASON);
  const retry = await run("retry", `${login} ${RETRY_MAIN}`, "visual");
  followUps.push({ purpose: "retry", reason: "Inspect the same seeded tag in a separate Kane session.", kane: retry });
  if (!distinctKaneRuns(kane, retry) || !editObservedOnFailedCheck(retry)) {
    return outcome("unconfirmed", "Kane did not reproduce the same failed Edit assertion in two distinct runs.");
  }

  if (!canRunFollowUp()) return outcome("unconfirmed", KANE_RUN_LIMIT_REASON);
  const control = await run("control", `${login} ${CONTROL_MAIN}`, "dom");
  const controlReason = control.objective.includes(MAIN_EDIT_NAME)
    ? "Check the original tag name in the Edit form, then save the rename on the ordinary Tags page."
    : "Use Edit and Save on the ordinary Tags page to test whether the control works.";
  followUps.push({ purpose: "control", reason: controlReason, kane: control });
  if (!distinctKaneRuns(kane, control) || !distinctKaneRuns(retry, control) || !renamedTag(control, "/tags", MAIN_TAG, "pinocchiotagmain", MAIN_RENAMED)) {
    return outcome("unconfirmed", "The control did not establish a successful rename in an independent run on the ordinary Tags page.");
  }

  const overrides = [tagBlameOverride("initial", kane), tagBlameOverride("retry", retry)].filter((entry) => entry !== undefined);
  return outcome("outdated", `Two independent Kane failures showed that the ordinary Tags page offers Edit for the seeded tag. ${MAIN_CONTROL_PROOF} ${TAG_HISTORY}`, overrides);
}

function editObservedOnFailedCheck(run: KaneRun): boolean {
  const assertionFailures = ["assertion_error.checkpoint_failed", "assertion_error.final_verification", "assertion_error.confirmed_product_bug"];
  if (run.status !== "failed" || !assertionFailures.includes(run.reasonCode) || !run.failedStep) return false;
  if (!matchesAssertion(run.failedStep.remark, EDIT_OFFERED, "false")) return false;
  if (!observedBoolean(run, ROW_PRESENT, "true", "true") || !observedBoolean(run, EDIT_OFFERED, "false", "true")) return false;
  const ready = assertionScreenshot(run, "/tags", ROW_PRESENT, "passed");
  const failed = assertionScreenshot(run, "/tags", EDIT_OFFERED, "failed");
  return Boolean(ready && failed && ready.ordinal < failed.ordinal);
}

function renamedTag(run: KaneRun, path: string, original: string, renamed: string, assertion: string): boolean {
  if (run.status !== "passed" || run.exitCode !== 0 || !observedBoolean(run, assertion, "true", "true")) return false;
  const result = assertionScreenshot(run, path, assertion, "passed");
  if (!result) return false;
  const originalField = path === "/tags" ? ordinaryTagForm(run) : undefined;
  if (path === "/tags" && run.objective.includes(MAIN_EDIT_NAME) && !originalField) return false;
  const actions = captures(run, "passed").filter(({ step }) => step.ordinal < result.ordinal);
  return savedTagRename(actions, path, original, renamed, originalField?.ordinal);
}

function ordinaryTagForm(run: KaneRun): StepEvidence | undefined {
  const observations = matchingObservations(run, MAIN_EDIT_NAME);
  if (observations.length === 0 || !observations.every((o) => {
    if (statedExpectation(o.condition, "true") !== "true") return false;
    return (o.expectedValue === MAIN_TAG && o.extractedValue === MAIN_TAG)
      || (normalise(o.expectedValue) === "true" && normalise(o.extractedValue) === "true");
  })) return undefined;
  return assertionScreenshot(run, "/tags", MAIN_EDIT_NAME, "passed");
}

function savedTagRename(actions: ReturnType<typeof captures>, path: string, original: string, renamed: string, formOrdinal?: number): boolean {
  const selected = selectedTag(actions, path, original, formOrdinal);
  if (!selected) return false;
  const ready = formOrdinal ?? selected.step.ordinal;
  const nameInput = new RegExp(`^type:.*["']${renamed}["'].*\\bname\\b`);
  const typed = actions.find((entry) => entry.step.ordinal > ready && entry.step.kind === "type"
    && onTagEditForm(path, entry.path) && nameInput.test(entry.summary));
  if (!typed || changedEditForm(actions, ready, typed.step.ordinal)) return false;
  const saved = actions.find((entry) => entry.step.ordinal > typed.step.ordinal && entry.path === typed.path
    && entry.step.kind === "click" && /^click:.*\bsave\b/.test(entry.summary));
  return Boolean(saved && !changedEditForm(actions, typed.step.ordinal, saved.step.ordinal));
}

function selectedTag(actions: ReturnType<typeof captures>, path: string, original: string, formOrdinal?: number) {
  const originalName = new RegExp(`\\b${original}\\b`);
  return actions.find((entry) => entry.path === path && entry.step.kind === "click"
    && (path !== "/tags" || /\bedit\b/.test(entry.summary))
    && (formOrdinal === undefined ? originalName.test(entry.summary) : entry.step.ordinal < formOrdinal));
}

function changedEditForm(actions: ReturnType<typeof captures>, after: number, before: number): boolean {
  return actions.some(({ step, summary }) => step.ordinal > after && step.ordinal < before
    && (step.kind === "navigate" || (step.kind === "click" && /\b(edit|cancel|close)\b/.test(summary))));
}

function onTagEditForm(listPath: string, path: string): boolean {
  // The ordinary app uses an in-page dialog. Django opens a separate edit page.
  return listPath === "/tags" ? path === listPath : /^\/admin\/bookmarks\/tag\/\d+\/change$/.test(path);
}

function observedBoolean(run: KaneRun, assertion: string, expected: "true" | "false", actual: "true" | "false"): boolean {
  const chosen = matchingObservations(run, assertion);
  return chosen.length > 0 && chosen.every((o) => statedExpectation(o.condition, expected) === expected
    && normalise(o.expectedValue) === expected && normalise(o.extractedValue) === actual);
}

function matchingObservations(run: KaneRun, assertion: string) {
  const stripExpectation = (text: string) => normalise(text).replace(/\.? expect (true|false)\.?$/, "").replace(/\.$/, "");
  return run.observations.filter((o) => stripExpectation(o.condition) === stripExpectation(assertion));
}

function statedExpectation(condition: string, expected: "true" | "false"): string {
  return /\bexpect (true|false)\.?$/.exec(normalise(condition))?.[1] ?? expected;
}

function matchesAssertion(remark: string, assertion: string, expected?: "true" | "false"): boolean {
  // The step record can truncate trailing instructions. Match the whole
  // assertion sentence and verify the boolean expectation in the observation.
  const summary = normalise(remark);
  const sentence = `assert: ${normalise(assertion)}`;
  if (!summary.startsWith(sentence)) return false;
  return !expected || `expect ${expected}.`.startsWith(summary.slice(sentence.length).trim());
}

function assertionScreenshot(run: KaneRun, path: string, assertion: string, status: "passed" | "failed"): StepEvidence | undefined {
  return captures(run, status).find((entry) => entry.path === path && entry.step.kind === "assert"
    && matchesAssertion(entry.summary, assertion, status === "failed" ? "false" : undefined))?.step;
}

function captures(run: KaneRun, status: "passed" | "failed") {
  if (!URL.canParse(run.startUrl)) return [];
  const origin = new URL(run.startUrl).origin;
  return run.evidence.flatMap((step) => {
    if (!step.screenshot || step.status !== status || !URL.canParse(step.url)) return [];
    const url = new URL(step.url);
    if (url.origin !== origin) return [];
    return [{ step, path: url.pathname.replace(/\/$/, ""), summary: normalise(step.summary) }];
  });
}

function tagBlameOverride(round: "initial" | "retry", run: KaneRun): Questioning["overrides"][number] | undefined {
  const blame = run.blame;
  if (!blame) return undefined;
  const cause = normalise(blame.rootCause);
  if (blame.category === "ui_state_mismatch" && cause.includes("ordinary app user should not be able to edit")) {
    return { round, family: blame.family, category: blame.category, hypothesis: "Kane assumed tag editing in the ordinary app was a product defect.", evidence: `${MAIN_CONTROL_PROOF} ${TAG_HISTORY}` };
  }
  if (blame.category === "config_issue" && cause.includes("test expectation is wrong for the page")) {
    return { round, family: blame.family, category: blame.category, hypothesis: "Kane attributed the failed expectation to the test configuration.", evidence: `The expectation came from the documentation. ${MAIN_CONTROL_PROOF} ${TAG_HISTORY}` };
  }
  return undefined;
}
