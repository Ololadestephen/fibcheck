# Changelog

## 0.1.2 (not yet published)

- `card --animate` writes an animated GIF of the share card beside the PNG (needs ffmpeg), and the command's help and usage list the flag.
- Share cards are redesigned around a fib meter that shows how many of the app's checked lines held up, with a verdict stamp, a caption, the quoted line and Kane's screenshot.

## 0.1.1 (2026-11-21)

- `attack` checks `--url` and `--login` the same way `check` does, and reads findings files through the same guarded loader as `card` and `confirm`.
- The model call limit refuses to run when its usage totals file has the wrong shape, not only when it cannot be parsed.
- `confirm` uses the Kane run that actually showed the contradiction, including a reworded run, and refuses if it did not fail.
- A claim's assertion mode is kept on every Kane run, saved by `freeze`, and covered by the frozen-claim hash. A frozen file whose hash predates this asks to be re-frozen.
- Needs Node.js 22 or newer, as `@google/genai` 3.3.0 does.

## 0.1.0 (2026-11-20)

- First release on npm: `check`, `report`, `freeze`, `confirm`, `attack` and `card`.
