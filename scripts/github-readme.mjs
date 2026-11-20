import { appendFileSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { runCheck } from "../dist/check.js";
import { githubComment, stageGitHubReadme } from "../dist/github.js";
import { createModelClient, loadDotEnv } from "../dist/model/config.js";
import { writeReport } from "../dist/report/report.js";

const env = process.env;
const credentials = env.FIBCHECK_ENV_FILE;
if (!credentials || !isAbsolute(credentials) || basename(credentials) !== ".env") {
  throw new Error("Supply an absolute path to the runner's private .env file.");
}
const envFile = realpathSync(credentials);
const workspace = realpathSync(env.GITHUB_WORKSPACE);
const pathFromWorkspace = relative(workspace, envFile);
if (pathFromWorkspace !== ".." && !pathFromWorkspace.startsWith(`..${sep}`) && !isAbsolute(pathFromWorkspace)) {
  throw new Error("Place the runner's credentials outside the workflow workspace.");
}
if (basename(envFile) !== ".env") throw new Error("The credentials file must be named .env.");

const privateDirectory = dirname(envFile);
const directory = mkdtempSync(join(privateDirectory, "pull-request-"));
const staged = await stageGitHubReadme({
  event: JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")),
  eventName: env.GITHUB_EVENT_NAME,
  apiUrl: env.GITHUB_API_URL,
  serverUrl: env.GITHUB_SERVER_URL,
  targetFile: env.FIBCHECK_TARGET_FILE,
  docsFile: env.FIBCHECK_DOCS_FILE || undefined,
  directory,
  maxClaims: Number(env.FIBCHECK_MAX_CLAIMS),
});
loadDotEnv(privateDirectory);
const workDir = join(privateDirectory, ".fibcheck");
const client = createModelClient(basename(directory), privateDirectory);
// The provider has read the key. Keep it out of the Docker and Kane children.
delete env.GEMINI_API_KEY;
delete env.GOOGLE_API_KEY;
const checked = await runCheck(client, { ...staged, workDir });
writeReport(join(staged.runsDir, checked.runId, "check.json"));

const summary = githubComment(checked, env.FIBCHECK_DOCS_FILE || undefined);
appendFileSync(env.GITHUB_OUTPUT, `report<<FIBCHECK_REPORT_END\n${summary}\nFIBCHECK_REPORT_END\n`);
appendFileSync(env.GITHUB_STEP_SUMMARY, summary + "\n");
