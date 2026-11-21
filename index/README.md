# The fibcheck index

**8 self-hosted apps checked. 0 of 17 README claims were false. In their docs pages and wikis, we confirmed 4 wrong or stale instructions across 3 projects: Linkding (2), Mealie (1) and Uptime Kuma (1).** Mealie's maintainers have merged our fix ([mealie-recipes/mealie#9212](https://github.com/mealie-recipes/mealie/pull/9212)).

On November 17 and 18, 2026, fibcheck checked claims from 8 popular self-hosted web apps, using Kane CLI to run each claim in a real browser against the app.

| Where the claim was written | Claims tested | Held | Unconfirmed | Confirmed false or outdated |
|---|---|---|---|---|
| README files (8 apps) | 17 | 16 | 1 | 0 |
| Docs pages and wikis (7 apps, plus Linkding's earlier checks) | 18 | 9 | 5 | 4 |

The READMEs held up well, and we report that as it is. A tool that checks claims is only useful if it can also say "this held". The wrong and stale instructions were deeper in the documentation, in step-by-step pages that name exact menus and settings. Those are the lines that quietly go out of date when an interface changes.

## The rule

A claim counts as false or outdated only when all of these are true:

1. Kane failed the documented assertion twice, in two separate runs.
2. Each failure was checked for a test mistake: the right page, a valid sign-in, test data that existed, and an input method Kane can perform.
3. A control run passed on the same app with the same account, which rules out a broken setup.

Kane decides every pass and fail. fibcheck's own model never does. Kane's own guess about who is at fault is a hypothesis, and we override it when the screenshots show otherwise.

## README claims

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

Each app ran in a fresh Docker container from a pinned image digest (the table shows each image's version tag for readability; the digests are in the run profiles), with disposable accounts and test data. No real user data was involved, and nothing was sent to the projects.

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

## Docs pages and wikis

We read each project's documentation pages and wiki at a pinned commit, not its README, and picked the sentences with exact interface names: menu and button labels, settings names, default values, shortcuts and "go to X, then Y" steps. Memos keeps its user documentation on a separate website, so it has no docs-page claims here. Each check was written by hand next to the quoted sentence, and every quote was verified against the document before Kane ran.

### Confirmed findings

Each of these failed twice in separate Kane runs, had a passing control, and was read by hand from the screenshots.

Where each screenshot below comes from (Kane session, time and step) is listed in [evidence/PROVENANCE.md](evidence/PROVENANCE.md).

- **Mealie, [FAQ line 30](https://github.com/mealie-recipes/mealie/blob/e2c0c3b1bfd7a785dde8e9704f1c8475333613ae/docs/docs/documentation/getting-started/faq.md?plain=1#L30): outdated.** "Click the Recipe Settings gear and deselect `Disable Ingredient Amounts`". In four runs, the Recipe Settings panel opened with six switches and none of them was Disable Ingredient Amounts ([run 1](evidence/mealie-docs-faq-l30-run.jpg), [run 2](evidence/mealie-docs-faq-l30-run2.jpg), [control](evidence/mealie-docs-faq-l30-control.jpg)). The six switches match Mealie's own `RecipeSettingsSwitches.vue` at the same commit. The switch was removed in Mealie's commit `245ca5f` on July 31, 2025 ("Remove 'Is Food' and 'Disable Amounts' Flags", #5684). **Fixed upstream:** the maintainers approved and merged our docs fix on November 20, 2026 ([mealie-recipes/mealie#9212](https://github.com/mealie-recipes/mealie/pull/9212), commit [`d17d11a`](https://github.com/mealie-recipes/mealie/commit/d17d11a65ba50a59f106cdb44a4304456bc880d9)). Before it was sent, Kane passed a fresh run that followed the corrected steps ([screenshot](evidence/mealie-docs-faq-after.jpg)).
- **Uptime Kuma, [wiki Maintenance page](https://github.com/louislam/uptime-kuma/wiki/Maintenance) line 12 (wiki commit `cf7fe32`): false.** "You can access the maintenance management via the menu at the top left." In two strict runs, clicking the top left of the header opened no menu ([run 1](evidence/uptime-kuma-wiki-maintenance-run.jpg), [run 2](evidence/uptime-kuma-wiki-maintenance-run2.jpg)). The control reached Maintenance through the profile menu at the top right ([control](evidence/uptime-kuma-wiki-maintenance-control.jpg)), which is also what the wiki's own screenshot shows, so this is most likely a slip of wording. A first, looser Kane run had passed this claim by asserting a menu that was not on screen, which is why every pass is read by hand.
- **Linkding, [admin.md line 14](https://github.com/sissbruecker/linkding/blob/27b7303baf41bb28babc610ac8eaa486e1ddfab5/docs/src/content/docs/admin.md?plain=1#L14): outdated.** "To open the Admin app, go the *Settings* view and click on the *Admin* tab." Two separate Kane runs found no Admin tab inside the Settings page ([run 1](evidence/linkding-docs-l14-run1.jpg)). A control with the same account opened Site administration through the Settings menu in the top navigation ([control](evidence/linkding-docs-l14-control.jpg)). Kane blamed the test account for missing admin rights; the control showed the account had them. Linkding's history shows the tab existed in the Settings template and was later removed.
- **Linkding, [admin.md line 55](https://github.com/sissbruecker/linkding/blob/27b7303baf41bb28babc610ac8eaa486e1ddfab5/docs/src/content/docs/admin.md?plain=1#L55): outdated.** "linkding UI currently only allows to create or assign tags". Two separate Kane runs found Edit and Remove actions on an existing tag on the ordinary Tags page ([run 1](evidence/linkding-docs-l55-run1.jpg)). A passing control renamed a tag on that same page and saw the new name ([control](evidence/linkding-docs-l55-control.jpg)). The second half of the sentence, that the admin app can manage tags, held.

We have not contacted these projects. Any issue or pull request will be shared with them in a friendly way, and only after a person on our side has approved the exact text.

### Lazy fixes we tried, and rejected

Before offering a fix, fibcheck's attacker plays a hurried editor and tries shortcuts that would make the failing check go away without fixing the docs. For each of the four findings it tried four:

| Shortcut | Result |
|---|---|
| Delete the line | Rejected by rule, 4 of 4: readers lose the instruction and nothing is left to check |
| Make it vague (for example "Linkding provides various options for managing tags") | Rejected by rule, 4 of 4: fewer checkable details than the proven fix |
| Hedge the wrong detail (for example "You can usually access … at the top left") | Rejected by rule, 4 of 4 |
| Swap in a plausible wrong detail (for example "the sidebar menu on the bottom left") | 4 of 4 inconclusive. Kane failed every one, but none of those runs tested the wrong sentence in the place it names, so none is counted |

So each card says "3 lazy fixes tried and rejected", all by rule. The wrong-detail runs taught us something too: in a first attempt Kane passed two wrong fixes by reaching the result through a different menu, and failed two for unrelated reasons. fibcheck now counts Kane's result only when the run tested the attempt's own place, and a person reviewed every one. Each attempt is in [attacks/](attacks/).

### Every docs-page claim

| App | Where | Claim | Result |
|---|---|---|---|
| Uptime Kuma | wiki, Maintenance | "via the menu at the top left" | False |
| Uptime Kuma | wiki, Reverse Proxy | "Go to `Settings` → `Reverse Proxy` → `HTTP Headers` and set `Trust Proxy` to Yes." | Held |
| Uptime Kuma | wiki, Badge | Badge maker from a status page in edit mode | Unconfirmed: Kane's run ended in an error |
| Mealie | features.md line 83 | The planner "shows you the previous day and the next 6 days by default" | Unconfirmed (see below) |
| Mealie | faq.md line 15 | "Click on your name in the upper left corner to get to your settings", then Manage Data | Held |
| Mealie | faq.md line 30 | "deselect `Disable Ingredient Amounts`" | Outdated |
| Linkding | shortcuts.md line 10 | The `n` key adds a new bookmark | Held |
| Linkding | search.md line 32 | A "lax" tag search mode in the settings | Unconfirmed: the check changed the setting after searching |
| File Browser | customization.md line 16 | Branding options under Settings → Global Settings | Held |
| File Browser | customization.md line 11 | "Disable Used Percentage" hides disk usage on the sidebar | Unconfirmed: the two failures had different causes |
| FreshRSS | 04_Subscriptions.md line 102 | Export through Subscriptions management, then Import / export | Held |
| FreshRSS | 08_sharing_services.md line 48 | The sharing menu is under Configuration / Display | Unconfirmed: the check did not match how the setting is shown |
| Shiori | Usage.md line 102 | `tag:` and `-tag:` in the search bar | Held |
| Shiori | Usage.md line 104 | Clicking a tag name in the tags dialog includes it | Held |
| PrivateBin | wiki, Configuration | Open discussion is not preselected by default | Held |
| PrivateBin | wiki, Configuration | File upload is off by default | Held |

**Mealie's planner range** is the one we would most like to finish. Both runs saw the default view as Sunday 15 to Saturday 21 November, with today on the 18th, not the previous day through six days ahead ([screenshot](evidence/mealie-docs-planner-run2.jpg)). Kane still marked the second run as passed, contradicting its own recorded dates, and the budget ran out before a third run. So it stays unconfirmed.

## Cost and discarded runs

- **README index, November 17:** 45 Kane runs, at most 9 for any app. Kane's own run reports add up to 1,928 credits; the account balance fell by 2,469 credits, because Kane charges a little more than its runs report.
- **Docs-page hunt, November 18:** the account balance fell by 1,392 credits for the 16 docs claims, their reproductions and controls.
- **Discarded runs.** These never count for or against a claim, and their evidence is kept:
  - early runs that shared one browser in parallel and opened the wrong app;
  - runs in a separate browser setup where sign-in did not submit;
  - two checks we wrote wrongly;
  - one test feed that FreshRSS blocked, because it refuses local addresses by default. We allowed only the fixture's own address, through FreshRSS's documented `internal_host_allowlist` setting.

## Limits

- A claim that held rests on one passing Kane run that tested it as written. That shows the feature worked in this version and setup. It does not prove every part of a broad claim.
- Kane cannot check new browser tabs or windows, and its text entry can bypass editors that format as you type. Claims like these stay unconfirmed.
- The index covers 2 or 3 claims per app, chosen because they can be tested in a browser. It is not a full audit of any README or documentation site.
- Wikis change without releases, so the Uptime Kuma and PrivateBin wiki claims are pinned to the wiki commit we read, not to an app version.
