# Where each docs-finding screenshot comes from

Each screenshot is Kane's own step screenshot from one Kane run, scaled to 1280 by 720. Nothing else is changed. The table names the run by its Kane session, when it finished (UTC), how long it took, and the step the screenshot belongs to.

Some pairs are pixel for pixel the same, for example run 1 and run 2 of the Linkding Admin tab check. They are separate Kane runs, with different sessions, durations and times, that ended on the same unchanged page at the same window size, so the browser drew identical images. The last column is the start of each file's SHA-256 hash, so matching images are easy to see.

Corrected on November 20, 2026. Before this, some files were not from the runs their names give: the Linkding run 2 files and "after the fix" files were added as byte-identical copies of the run 1 and control files and could not be traced to their own runs; the Mealie run 1 file could not be traced to a single run, because a passing control run shows the same panel; and all three Uptime Kuma files came from an earlier, looser run that passed. Every file below was rebuilt from the run it names. The file names did not change, so existing links still work.

| File | Role | Kane session | Finished (UTC) | Duration | Step | Step summary | SHA-256 |
|---|---|---|---|---|---|---|---|
| `linkding-docs-l14-run1.jpg` | Run 1 (failed) | `17cfdebc` | 2026-11-16 17:32 | 119.5 s | 13 (failed) | assert: The Settings page contains an in-page Admin tab. Expect true. | `f4a6ecc0` |
| `linkding-docs-l14-run2.jpg` | Run 2, separate run (failed) | `43613b29` | 2026-11-16 17:35 | 156 s | 14 (failed) | assert: The Settings page contains an in-page Admin tab. Expect true. | `f4a6ecc0` |
| `linkding-docs-l14-control.jpg` | Control (passed) | `e84467ec` | 2026-11-16 17:37 | 99.4 s | 16 (passed) | assert: The Site administration dashboard shows the account pinotest. | `284b5113` |
| `linkding-docs-l14-after.jpg` | After the fix (passed) | `289a131f` | 2026-11-16 20:41 | 130.3 s | 16 (passed) | assert: The Site administration dashboard shows the account pinotest. | `284b5113` |
| `linkding-docs-l55-run1.jpg` | Run 1 (failed) | `994fca28` | 2026-11-16 21:43 | 86.2 s | 13 (failed) | assert: The pinocchiotag row has an Edit control on the ordinary Linkding Tags p | `78dcf62e` |
| `linkding-docs-l55-run2.jpg` | Run 2, separate run (failed) | `12bfca83` | 2026-11-16 21:45 | 114.7 s | 15 (failed) | assert: The pinocchiotag row has an Edit control on the ordinary Linkding Tags p | `78dcf62e` |
| `linkding-docs-l55-control.jpg` | Control (passed) | `0f6c5b99` | 2026-11-16 21:47 | 109.8 s | 18 (passed) | assert: The ordinary Linkding Tags page lists pinocchiotagmain. | `f704e759` |
| `linkding-docs-l55-after.jpg` | After the fix (passed) | `19f5ae95` | 2026-11-16 22:59 | 103.4 s | 18 (passed) | assert: The ordinary Linkding Tags page lists pinocchiotagmain. Expect true. | `f704e759` |
| `mealie-docs-faq-l30-run.jpg` | Run 1 (failed) | `0db33f2f` | 2026-11-18 08:22 | 187 s | 19 (failed) | wait: Waiting after checking the Recipe Settings menu | `ed2a2874` |
| `mealie-docs-faq-l30-run2.jpg` | Run 2, separate run (failed) | `d4760d0a` | 2026-11-18 08:25 | 169 s | 18 (failed) | assert: the recipe settings include an option named Disable Ingredient Amounts.  | `ed2a2874` |
| `mealie-docs-faq-l30-control.jpg` | Control (passed) | `37a08e17` | 2026-11-18 09:02 | 173.4 s | 20 (passed) | assert: a recipe settings panel opens and lists at least one option with an on a | `78ff3f0f` |
| `uptime-kuma-wiki-maintenance-run.jpg` | Run 1 (failed) | `69a99970` | 2026-11-18 08:04 | 107.6 s | 14 (failed) | assert: A menu is open at the top left of the page and it lists a Maintenance it | `c61c6ef8` |
| `uptime-kuma-wiki-maintenance-run2.jpg` | Run 2, separate run (failed) | `b04cd678` | 2026-11-18 08:06 | 97.1 s | 13 (failed) | assert: A menu is open at the top left of the page and it lists a Maintenance it | `c61c6ef8` |
| `uptime-kuma-wiki-maintenance-control.jpg` | Control (passed) | `611d8c1b` | 2026-11-18 08:59 | 116 s | 18 (passed) | assert: The Maintenance page with a Schedule Maintenance button opens. Expected: | `bb8869ef` |
