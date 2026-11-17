# The fibcheck index

**8 apps checked, 0 README claims confirmed false or outdated.**

On November 17, 2026, fibcheck checked 17 claims from the READMEs of 8 popular self-hosted web apps. It used Kane CLI to run each claim in a real browser against the app. 16 claims held. 1 is unconfirmed, because the failure came from how the test typed text, not from the app. No claim met our bar for calling it false.

This is a good result for these projects, and we report it as it is. A tool that checks claims is only useful if it can also say "this held".

## The rule

A claim counts as false or outdated only when all of these are true:

1. Kane failed the documented assertion twice, in two separate runs.
2. Each failure was checked for a test mistake: the right page, a valid sign-in, test data that existed, and an input method Kane can perform.
3. A control run passed on the same app with the same account, which rules out a broken setup.

Kane decides every pass and fail. fibcheck's own model never does. Kane's own guess about who is at fault is a hypothesis, and we override it when the screenshots show otherwise.

## Results

| App | README at | App image | Claims tested | Held | Unconfirmed | False or outdated |
|---|---|---|---|---|---|---|
| [Linkding](https://github.com/sissbruecker/linkding/blob/27b7303baf41bb28babc610ac8eaa486e1ddfab5/README.md) | `27b7303` | `sissbruecker/linkding:1.47.0` | 2 | 2 | 0 | 0 |
| [Shiori](https://github.com/go-shiori/shiori/blob/aebb4021a56048eed4c8feb325399be5f46e5470/README.md) | `aebb402` | `ghcr.io/go-shiori/shiori` (pinned digest) | 2 | 2 | 0 | 0 |
| [PrivateBin](https://github.com/PrivateBin/PrivateBin/blob/9ffe9c8f7619859255dea4d975bc4e4c8211db95/README.md) | `9ffe9c8` | `privatebin/nginx-fpm-alpine` 2.1.1 (pinned digest) | 2 | 2 | 0 | 0 |
| [Uptime Kuma](https://github.com/louislam/uptime-kuma/blob/1e3e2eee51821c453329ee8d7145be0568712863/README.md) | `1e3e2ee` | `louislam/uptime-kuma:2` (pinned digest) | 2 | 2 | 0 | 0 |
| [Mealie](https://github.com/mealie-recipes/mealie/blob/e2c0c3b1bfd7a785dde8e9704f1c8475333613ae/README.md) | `e2c0c3b` | `ghcr.io/mealie-recipes/mealie:v3.31.0` | 2 | 2 | 0 | 0 |
| [File Browser](https://github.com/filebrowser/filebrowser/blob/e8a388f840173580116f2743813d03b22286e44e/README.md) | `e8a388f` | `filebrowser/filebrowser:v2.63.23` | 2 | 2 | 0 | 0 |
| [Memos](https://github.com/usememos/memos/blob/938ceae84223a0a7be77720359f2dabdacf97bb8/README.md) | `938ceae` | `ghcr.io/usememos/memos:26.11.1` | 2 | 1 | 1 | 0 |
| [FreshRSS](https://github.com/FreshRSS/FreshRSS/blob/08f97bd497ace733c151ea1c709d85cd5b65cc53/README.md) | `08f97bd` | `ghcr.io/freshrss/freshrss:1.30.4` | 3 | 3 | 0 | 0 |
| **Total** | | | **17** | **16** | **1** | **0** |

Each app ran in a fresh Docker container from a pinned image digest, with disposable accounts and test data. No real user data was involved, and nothing was sent to the projects.

## Every claim, with its last screenshot

The screenshot is Kane's final step for the run that decided the claim. We read each one before publishing.

| App | README line | Claim | What Kane did | Result | Evidence |
|---|---|---|---|---|---|
| Linkding | 21 | "Organize bookmarks with tags" | Made two bookmarks with different tags, filtered by one tag, and saw only the matching bookmark | Held | [screenshot](evidence/linkding-l21.jpg) |
| Linkding | 22 | "Markdown notes" | Wrote a heading and a bold word in a bookmark's notes and saw them rendered | Held | [screenshot](evidence/linkding-l22.jpg) |
| Shiori | 16 | "add, edit" | Added a bookmark, edited it through the card's own Edit button, and saw the new title | Held | [screenshot](evidence/shiori-l16.jpg) |
| Shiori | 16 | "delete and search" | Found a bookmark by search, deleted it, and the same search came back empty | Held | [screenshot](evidence/shiori-l16-2.jpg) |
| PrivateBin | 74 | "including a "forever" and "burn after reading" option" | Chose the "Never" expiry and ticked "Burn after reading", each checked separately | Held | [screenshot](evidence/privatebin-l74.jpg) |
| PrivateBin | 76 | "Markdown format support for HTML formatted pastes, including preview function" | Typed Markdown and opened Preview: a real heading and bold text | Held | [screenshot](evidence/privatebin-l76.jpg) |
| Uptime Kuma | 30 | "20-second intervals" | Saved a monitor with a 20-second interval and reopened it: still 20 | Held | [screenshot](evidence/uptime-kuma-l30.jpg) |
| Uptime Kuma | 32 | "Multiple status pages" | Saved two status pages; both are listed | Held | [screenshot](evidence/uptime-kuma-l32.jpg) |
| Mealie | 48 | "or entering data manually" | Created a recipe by hand with an ingredient and reopened it | Held | [screenshot](evidence/mealie-l48.jpg) |
| Mealie | 49 | "Use the **Meal Planner** to plan your what you'll cook for the next week" | Planned a recipe for a day next week and reloaded the planner | Held | [screenshot](evidence/mealie-l49.jpg) |
| File Browser | 9 | "preview and edit your files" | Previewed a file, changed its text, saved and reopened it | Held | [screenshot](evidence/filebrowser-l9.jpg) |
| File Browser | 9 | "delete, preview and edit your files" | Previewed and edited a second file, deleted it, and reloaded: gone | Held | [screenshot](evidence/filebrowser-l9-2.jpg) |
| Memos | 29 | "using Markdown to give your words more structure" | Saved a memo with Markdown; it showed `#` and `**` as plain text | Unconfirmed | [screenshot](evidence/memos-l29.jpg) |
| Memos | 30 | "Tags connect related thoughts across those days" | Filtered by a tag: both matching memos shown, the other memo hidden | Held | [screenshot](evidence/memos-l30.jpg) |
| FreshRSS | 12 | "It supports custom tags." | Created the label PinoTag, applied it to an article, and found the article under that label | Held | [screenshot](evidence/freshrss-l12.jpg) |
| FreshRSS | 12 | "It is a multi-user application" | Opened user management and saw two separate accounts | Held | [screenshot](evidence/freshrss-l12-2.jpg) |
| FreshRSS | 119 | "The date and time in the right-hand column is the date declared by the feed" | The test feed declared 15 January 2025, 12:34 GMT; FreshRSS showed 15 January 2025 at 12:34 (+00:00) | Held | [screenshot](evidence/freshrss-l119.jpg) |

### Why the Memos claim is unconfirmed, not false

Kane failed this claim twice, and a plain-text control memo passed, so it met the numbers. We still do not call it false. The Memos editor turns Markdown into formatting as you type. When we typed `# ` one key at a time in an ordinary browser, Memos made a real heading. Kane enters text in a way that skips that conversion, so the editor saved the characters as plain text. The failure comes from the test's input method, which is exactly the kind of test mistake the rule above has to rule out.

## Kane's blame labels that the evidence overruled

- **Mealie, "or entering data manually".** On the first try, Kane blamed Mealie: "the name is already taken". The screenshot shows no error, only the help text "New recipe names must be unique", and Kane left the page before the new recipe opened. A clearer run passed.
- **Shiori, "add, edit".** In one browser setup, Kane said the add button did nothing and blamed Shiori. The same button opened the add dialog in Kane's own browser, before and after. We treated it as a problem with that setup.

## What a confirmed finding looks like

The index found nothing false, but fibcheck has confirmed two outdated statements in Linkding's documentation (`docs/src/content/docs/admin.md` at `27b7303`, not its README). Both passed the full rule above.

- **Line 14:** "To open the Admin app, go the *Settings* view and click on the *Admin* tab." Two separate Kane runs found no Admin tab inside the Settings page ([run 1](evidence/linkding-docs-l14-run1.jpg)). A control with the same account opened Site administration through the Settings menu in the top navigation ([control](evidence/linkding-docs-l14-control.jpg)). Kane blamed the test account for missing admin rights; the control showed the account had them. Linkding's history shows the tab existed in the Settings template and was later removed, which makes the statement outdated rather than false.
- **Line 55:** "linkding UI currently only allows to create or assign tags". Two separate Kane runs found Edit and Remove actions on an existing tag on the ordinary Tags page ([run 1](evidence/linkding-docs-l55-run1.jpg)). A passing control renamed a tag on that same page and saw the new name ([control](evidence/linkding-docs-l55-control.jpg)). The second half of the sentence, that the admin app can manage tags, held.

We have not contacted the Linkding project about these. Any issue or pull request will be shared with them in a friendly way, and only after a person on our side has approved the exact text.

## Cost and discarded runs

- **Kane runs:** 45 in all, at most 9 for any app.
- **Credits:** Kane's own run reports add up to 1,928 credits. The account balance fell by 2,469 credits, because Kane charges a little more than its runs report.
- **Discarded runs.** These never count for or against a claim, and their evidence is kept:
  - early runs that shared one browser in parallel and opened the wrong app;
  - runs in a separate browser setup where sign-in did not submit;
  - two checks we wrote wrongly;
  - one test feed that FreshRSS blocked, because it refuses local addresses by default. We allowed only the fixture's own address, through FreshRSS's documented `internal_host_allowlist` setting.

## Limits

- A claim that held rests on one passing Kane run that tested it as written. That shows the feature worked in this version and setup. It does not prove every part of a broad claim.
- Kane cannot check new browser tabs or windows, and its text entry can bypass editors that format as you type. Claims like these stay unconfirmed.
- The index covers 2 or 3 claims per app, chosen because they can be tested in a browser. It is not a full audit of any README.
