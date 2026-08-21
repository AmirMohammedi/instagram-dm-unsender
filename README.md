# Instagram DM Unsender

A userscript that unsends every message **you** sent in an Instagram DM thread, one at a time, from the newest backwards — built to survive conversations with tens of thousands of messages.

It adds a small draggable panel to Instagram Web with a start/stop button, live counters and a status line. Everything runs in your browser against the normal Instagram UI: there is no server, no API token and no third party involved.

<br>

> [!WARNING]
> **Unsending is permanent.** Messages are deleted for everyone in the conversation and cannot be recovered.
> Automating the Instagram UI is also against Instagram's Terms of Use, and heavy use can get an account rate limited or actioned. Use it on your own account, at your own risk.

<br>

## Install

1. Install a userscript manager — [Violentmonkey](https://violentmonkey.github.io/) or [Tampermonkey](https://www.tampermonkey.net/).
2. Open [`idmu.user.js`](idmu.user.js), click **Raw**, and confirm the install prompt.
3. Reload `instagram.com`.

There is no build step: the script is a single self-contained file with no dependencies (`@grant none`).

## Use

1. Open a conversation on Instagram Web — the panel only appears on `/direct/t/…` pages.
2. Click **Unsend all DMs**.
3. Leave the tab open and in the foreground. The rest of the page is locked behind a scrim while a run is in progress, so a stray click or keypress cannot navigate away mid-unsend.
4. Press **Esc**, or click **Stop**, to end the run at the next safe checkpoint.

The panel shows three counters:

| Counter | Meaning |
| --- | --- |
| **Unsent** | Messages successfully unsent in this run |
| **Pages** | Older message pages pulled in from Instagram so far |
| **Elapsed** | Time since the run started |

A per-conversation running total is kept in `localStorage`, so the hint line tells you how many messages have been unsent in this chat across all runs. Drag the panel by its header to move it; where you leave it is remembered.

## How it works

Instagram only renders the "…" menu on a message when you actually hover it, and only keeps a small window of the thread in the DOM. So a run is a loop:

1. **Scan** the loaded part of the thread for the next message of yours, scrolling a viewport at a time. The scan cursor is a frontier: everything between it and the newest message has already been cleared, so a scan resumes there instead of re-crossing the whole conversation.
2. **Unsend it** by replaying what a real cursor does: hover the row, open the "…" menu, pick *Unsend*, confirm the dialog.
3. **Verify** it actually went away — Instagram removes the row optimistically and puts it back when the server refuses.
4. When nothing of yours is left on screen, **load one older page** and repeat.

Older pages are fetched only once the loaded region has been cleared, so the DOM stays at roughly one viewport no matter how long the conversation is, and the scan cost does not grow with thread length.

Deliberate design decisions worth knowing about:

- **Slow is a stall, not the end.** A page fetch that hasn't answered is reported as *stalled* and retried with exponential backoff, never as "reached the top". Conflating the two is what makes naive scripts stop early and claim they are done.
- **The end of the thread is confirmed four times** before the run declares itself finished.
- **Requests are paced** 1–2 seconds apart with jitter, and a message that reappears after an unsend is treated as a rate limit and backed off from.
- **Sender detection is cached** on each row. Working it out requires `getComputedStyle`, which forces a style recalculation; a message's author never changes, so it is computed once.
- **Nothing walks the whole thread.** Locating the row container and counting rows are needed constantly, so the container is resolved once and kept, and the search that finds it stops at the container rather than descending into every message. Both costs would otherwise grow with each page loaded, which is what makes deeply paged conversations crawl.
- **Before declaring the thread finished**, the run sweeps the entire loaded conversation once, to pick up any row Instagram had not rendered when the scan first passed over it.
- **The panel is built node by node**, never through `innerHTML`, so it keeps working under Instagram's Trusted Types policy.

## Layout of the script

`idmu.user.js` is a single file organised into layers, each depending only on the ones above it:

| Layer | Contents |
| --- | --- |
| 1. Configuration | Selectors, timings, limits, storage keys |
| 2. Utilities | Sleep, clamp, backoff, formatting, safe `localStorage` |
| 3. DOM primitives | Element creation, synthetic pointer and keyboard input |
| 4. Async DOM | "Wait for this element", bounded by timeout and abort |
| 5. Thread probes | Finding the message list and your own messages in it |
| 6. `MessageRow` | The unsend workflow for a single message |
| 7. `MessageThread` | Scrolling, paging and scanning the conversation |
| 8. `UnsendRun` | The orchestrator: unsend, load older, back off, repeat |
| 9. Panel view | Stylesheet and element factories |
| 10. `ControlPanel` | Buttons, drag, timer, route changes, input lock |
| 11. Bootstrap | Entry point |

Everything that depends on Instagram's markup lives in the `SELECTORS` object at the top of the file, and every delay, retry count and backoff curve lives in `TIMING` and `LIMITS` next to it. When a redesign breaks the script, those objects are the first — and usually the only — place to look.

## Troubleshooting

**"Errored after 0 message(s)."** The message list could not be found, which almost always means Instagram changed its markup. Open the browser console for the failing selector and update `SELECTORS` at the top of the script.

**"Instagram stopped serving older messages."** Instagram has stopped answering requests for older pages. Reload the page, wait a few minutes and run again — the per-conversation total picks up where it left off.

**Nothing happens when you click.** Check that the URL is a conversation (`/direct/t/…`), and that the console shows the script running. The panel hides itself everywhere else on Instagram.

**Very long threads** may need more than one run. This is expected: rate limits are real, and the script would rather stop and tell you than hammer the API.

## Known limitations

- Instagram Web only — there is no mobile equivalent, and the script does nothing in the app's mobile layout.
- Only messages you sent can be unsent, which is an Instagram limitation, not a script one.
- The *Unsend* menu item is matched against a fixed list of localisations (English, Italian, Portuguese, Spanish, French, German). Other interface languages need one line added to `UNSEND_LABELS`.
- A message whose workflow fails is retried with exponential backoff, but five failures in a row end the run — normally a sign that Instagram is rate limiting the account rather than that anything is broken.

## Compatibility

Written for Instagram Web in an up-to-date Chromium or Firefox, driven by Violentmonkey or Tampermonkey. The script uses `AbortController`, `MutationObserver`, `Element.checkVisibility` (optional, feature-detected) and private class fields, so it needs a browser from 2022 onwards.

## Author

Written and maintained by **Amir Elcharif Mohammedi** — [github.com/amirMohammedi](https://github.com/amirMohammedi)

Copyright © 2026 Amir Elcharif Mohammedi.
