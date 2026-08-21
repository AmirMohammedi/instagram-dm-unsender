
// ==UserScript==

// @name				instagram-dm-unsender
// @copyright			Copyright (c) 2026, Amir Elcharif Mohammedi (https://github.com/amirMohammedi)
// @namespace			https://github.com/amirMohammedi
// @author				Amir Elcharif Mohammedi (https://github.com/amirMohammedi)
// @homepageURL			https://github.com/amirMohammedi
// @supportURL			https://github.com/amirMohammedi
// @icon				https://www.instagram.com/favicon.ico
// @version				1.0.0
// @description			Unsend every DM you sent in an Instagram thread — built to survive very long conversations.
// @run-at				document-end
// @include				/^https://(www\.)?instagram\.com/*/
// @grant				none

// ==/UserScript==

/*
 * Instagram DM Unsender
 * Written and maintained by Amir Elcharif Mohammedi — https://github.com/amirMohammedi
 */


/*
 * Layout of this file, top to bottom. Each layer only depends on the ones above it.
 *
 *   1. Configuration   selectors, timings, limits and storage keys, in one place
 *   2. Utilities       time, backoff, formatting, best-effort persistence
 *   3. DOM primitives  element creation and synthetic pointer/keyboard input
 *   4. Async DOM       "wait until this element shows up", bounded by timeout + abort
 *   5. Thread probes   locating Instagram's message list and our own messages in it
 *   6. MessageRow      the unsend workflow for a single message
 *   7. MessageThread   scrolling, paging and scanning of the whole conversation
 *   8. UnsendRun       the orchestrator: unsend, load older, back off, repeat
 *   9. Panel view      stylesheet and element factories for the on-screen panel
 *  10. ControlPanel    the panel's behaviour: buttons, drag, timer, route changes
 *  11. Bootstrap       entry point
 */
(function (exports) {
    "use strict";

    // -----------------------------------------------------------------------
    // 1. Configuration
    // -----------------------------------------------------------------------

    /** Author credit rendered in the panel header. */
    const AUTHOR = {
        name: "Amir Elcharif Mohammedi",
        handle: "github.com/amirMohammedi",
        url: "https://github.com/amirMohammedi",
    };

    /**
     * Every selector that depends on Instagram's markup. When the script breaks after
     * a redesign, this object is the first (and usually the only) thing to update.
     */
    const SELECTORS = {
        /** The conversation pagelet; the message list lives somewhere inside it. */
        conversation: "[data-pagelet='IGDMessagesList']",
        /** Present on rendered message bubbles; absent once a message is unsent. */
        bubble: "[role=none], [role=presentation]",
        /** Instagram's own "loading older messages" spinner. */
        loader: "[role=progressbar]",
        /** The confirmation dialog and its buttons. */
        dialog: "[role=dialog]",
        dialogButton: "[role=dialog] button",
        /** Dropdowns that a previous, failed workflow may have left open. */
        openMenu: "[role=menu], [role=listbox]",
        /** Where a menu item's label text can be found. */
        menuLabel: "[role=menu] span, [role=menu] div, [role=menuitem] span, [role=menuitem] div",
        /** Root of Instagram's React app, watched for client-side navigation. */
        appRoot: "[id^=mount] > div > div > div",
        /**
         * The "..." button revealed when a message is hovered. Instagram has moved the
         * aria-label between the button, a wrapper and a nested SVG title over time, and
         * localises it, so several spellings are tried from most to least specific.
         */
        actionButton: [
            "[aria-label^='See more options for message']",
            "[aria-label*='more options']",
            "[aria-label*='More']",
            "[aria-label*='Altre opzioni']",
            "[aria-label*='opzioni']",
            "[aria-label*='opciones']",
            "[aria-label*='options']",
        ],
        /** Last resort for the "..." button: any menu-opening button inside the row. */
        actionButtonFallback: "[role=button][aria-haspopup=menu]",
    };

    /** Localised spellings of the "Unsend" menu item, compared case-insensitively. */
    const UNSEND_LABELS = [
        "unsend",        // English
        "annulla invio", // Italian
        "retirar",       // Portuguese
        "deshacer",      // Spanish
        "retirer",       // French
        "zurücknehmen",  // German
    ];

    /**
     * Attributes IDMU writes onto Instagram's message rows to remember what it has
     * already looked at. They are cleared at the start of every run.
     */
    const MARKER = {
        /** Skip this row: it failed, or it was already handed to the workflow. */
        ignore: "data-idmu-ignore",
        /** The workflow completed for this row. */
        unsent: "data-idmu-unsent",
        /** Cached sender test: "1" when we sent the message, "0" when we did not. */
        own: "data-idmu-mine",
    };

    /** localStorage keys. The per-thread total is keyed by conversation path. */
    const STORAGE = {
        panelPosition: "idmu:position",
        threadTotal: (pathname) => `idmu:total:${pathname}`,
    };

    /** Path prefix of a conversation; the panel only shows itself here. */
    const THREAD_PATH_PREFIX = "/direct/t/";

    /** Every delay and deadline in milliseconds. */
    const TIMING = {
        /** How long React needs to settle after a synthetic hover. */
        hoverSettle: 100,
        /** Pause between hover attempts. */
        hoverRetry: 50,
        /** Deadline for the "..." button to appear once we hover for real. */
        actionButton: 3000,
        /** Deadline for the actions menu to open and show an "Unsend" item. */
        actionsMenu: 3000,
        /** Pause after pressing Escape while cleaning up a failed workflow. */
        overlayDismiss: 200,
        /** Grace period for React to hydrate the thread before the first scan. */
        hydrate: 600,
        /** How long to wait before believing a row really did disappear. */
        unsendSettle: 800,
        /** One frame: enough for the browser to apply a programmatic scroll. */
        scanSettle: 16,
        /** How long to sit at the top waiting for Instagram to start fetching. */
        loaderAppear: 2500,
        /** How long to wait for an in-flight fetch to land before calling it stalled. */
        loaderClear: 30000,
        /** Polling intervals while waiting for the loader to appear / disappear. */
        loaderAppearPoll: 100,
        /** Polling interval while an older page is being fetched. */
        loaderClearPoll: 200,
        /** Minimum spacing between two unsends, plus up to the same amount of jitter. */
        unsendGap: 1000,
        /** Longest single sleep inside a countdown, so it stays responsive to Stop. */
        countdownTick: 400,
    };

    /** Retry counts, depth limits and backoff ceilings. */
    const LIMITS = {
        /** Synthetic-hover attempts before falling back to a mutation observer. */
        hoverAttempts: 3,
        /** How deep to spray hover events below a message row. */
        hoverDepth: 8,
        /** How deep to look for the flex-end alignment that marks our own messages. */
        senderDepth: 8,
        /** How deep to look for the div that actually holds the message rows. */
        rowContainerDepth: 3,
        /** A node with more children than this is the row container, not a wrapper. */
        rowContainerFanout: 32,
        /** Give up on the run after this many message failures in a row. */
        consecutiveFailures: 5,
        /** How many consecutive "end of thread" verdicts before we believe it. */
        endConfirmations: 4,
        /** How many stalled page fetches to ride out before giving up. */
        stalls: 6,
        /** Backoff after a stalled page fetch. */
        stallBackoff: { baseMs: 3000, capMs: 45000 },
        /** Backoff after Instagram silently refuses an unsend (rate limiting). */
        rateLimitBackoff: { baseMs: 5000, capMs: 60000 },
        /** Backoff after the unsend workflow throws. */
        workflowBackoff: { baseMs: 3000, capMs: 60000 },
    };

    // -----------------------------------------------------------------------
    // 2. Utilities
    // -----------------------------------------------------------------------

    /**
     * @param {number} ms
     * @returns {Promise<void>}
     */
    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * @param {number} value
     * @param {number} min
     * @param {number} max
     * @returns {number} value, kept inside [min, max]
     */
    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }

    /**
     * Exponential backoff: doubles per attempt, never past the cap.
     *
     * @param {number} attempt - 1 for the first failure
     * @param {{baseMs: number, capMs: number}} curve
     * @returns {number} milliseconds
     */
    function backoffDelay(attempt, curve) {
        return Math.min(curve.capMs, curve.baseMs * Math.pow(2, Math.max(0, attempt - 1)));
    }

    /**
     * Formats a duration the way a stopwatch would: m:ss, or h:mm:ss past an hour.
     *
     * @param {number} ms
     * @returns {string}
     */
    function formatElapsed(ms) {
        const totalSeconds = Math.max(0, Math.floor(ms / 1000));
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        const pad = (value) => String(value).padStart(2, "0");
        return hours > 0
            ? `${hours}:${pad(minutes)}:${pad(seconds)}`
            : `${minutes}:${pad(seconds)}`;
    }

    /**
     * localStorage can be unavailable or throw (private mode, blocked storage, quota).
     * Nothing IDMU stores is essential, so every access degrades to a sane default
     * instead of interrupting a run.
     */
    const preferences = {

        /**
         * @param {Window} window
         * @param {string} key
         * @returns {string|null}
         */
        read(window, key) {
            try {
                return window.localStorage.getItem(key);
            } catch (ex) {
                console.debug("IDMU: unable to read", key, ex);
                return null;
            }
        },

        /**
         * @param {Window} window
         * @param {string} key
         * @param {string} value
         */
        write(window, key, value) {
            try {
                window.localStorage.setItem(key, value);
            } catch (ex) {
                console.debug("IDMU: unable to persist", key, ex);
            }
        },

        /**
         * @param {Window} window
         * @param {string} key
         * @returns {number} 0 when missing or unparseable
         */
        readCount(window, key) {
            const parsed = parseInt(this.read(window, key) || "0", 10);
            return Number.isFinite(parsed) ? parsed : 0;
        },

        /**
         * @param {Window} window
         * @param {string} key
         * @returns {object|null}
         */
        readJSON(window, key) {
            const raw = this.read(window, key);
            if (raw === null) {
                return null;
            }
            try {
                return JSON.parse(raw);
            } catch (ex) {
                console.debug("IDMU: unable to parse", key, ex);
                return null;
            }
        },

    };

    // -----------------------------------------------------------------------
    // 3. DOM primitives
    // -----------------------------------------------------------------------

    /**
     * Minimal element factory.
     *
     * Nodes are built one at a time rather than through innerHTML so the script keeps
     * working on pages that enforce Trusted Types, which Instagram does.
     *
     * @param {Document} document
     * @param {string} tagName
     * @param {{className?: string, id?: string, text?: string, attrs?: object}} [options]
     * @param {Element[]} [children]
     * @returns {Element}
     */
    function createElement(document, tagName, options = {}, children = []) {
        const node = document.createElement(tagName);
        if (options.className) {
            node.className = options.className;
        }
        if (options.id) {
            node.id = options.id;
        }
        if (options.text !== undefined) {
            node.textContent = options.text;
        }
        for (const [name, value] of Object.entries(options.attrs || {})) {
            node.setAttribute(name, value);
        }
        for (const child of children) {
            node.appendChild(child);
        }
        return node;
    }

    /**
     * The pointer and mouse events a real cursor fires when it enters an element, in
     * order. Instagram's React listens for pointer events, so mouse events alone do
     * not reveal the per-message "..." button.
     *
     * Each entry is [constructor, type, bubbles].
     */
    const HOVER_IN = [
        [PointerEvent, "pointerenter", false],
        [PointerEvent, "pointerover", true],
        [PointerEvent, "pointermove", true],
        [MouseEvent, "mouseenter", false],
        [MouseEvent, "mouseover", true],
        [MouseEvent, "mousemove", true],
    ];

    /** The matching sequence for the cursor leaving an element. */
    const HOVER_OUT = [
        [PointerEvent, "pointerout", true],
        [PointerEvent, "pointerleave", false],
        [MouseEvent, "mouseout", true],
        [MouseEvent, "mouseleave", false],
    ];

    /**
     * Dispatches one of the hover sequences above, aimed at the centre of the target.
     *
     * @param {Element} target
     * @param {Array} sequence - HOVER_IN or HOVER_OUT
     */
    function dispatchHover(target, sequence) {
        const rect = target.getBoundingClientRect();
        const init = {
            cancelable: true,
            clientX: rect.x + rect.width / 2,
            clientY: rect.y + rect.height / 2,
            pointerId: 1,
            pointerType: "mouse",
        };
        for (const [EventConstructor, type, bubbles] of sequence) {
            target.dispatchEvent(new EventConstructor(type, { ...init, bubbles }));
        }
    }

    /**
     * Sends Escape to the page, which is how Instagram closes menus and dialogs.
     *
     * @param {Document} document
     */
    function pressEscape(document) {
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }

    /**
     * Element nodes added by a batch of mutation records.
     *
     * @param {MutationRecord[]} mutations
     * @returns {Element[]}
     */
    function addedElements(mutations) {
        const elements = [];
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    elements.push(node);
                }
            }
        }
        return elements;
    }

    // -----------------------------------------------------------------------
    // 4. Async DOM
    // -----------------------------------------------------------------------

    /** A step gave up because the surrounding run was stopped. */
    class AbortedError extends Error {
        constructor(step, reason) {
            super(`${step} aborted: ${reason}`);
            this.name = "AbortedError";
        }
    }

    /** A step gave up because Instagram did not respond in time. */
    class TimeoutError extends Error {
        constructor(step, ms) {
            super(`${step} timed out after ${ms}ms`);
            this.name = "TimeoutError";
        }
    }

    /**
     * Resolves as soon as `probe` returns something truthy: immediately if it already
     * does, otherwise on the next DOM mutation under `target` that satisfies it.
     *
     * `probe` receives the mutation records when it is called from the observer and
     * nothing when it is called directly, which lets callers cheaply inspect only what
     * changed and fall back to a full query.
     *
     * @param {Element} target - subtree to observe
     * @param {function(MutationRecord[]=): (Element|null|undefined)} probe
     * @param {AbortSignal} signal
     * @returns {Promise<Element>}
     */
    function waitForElement(target, probe, signal) {
        return new Promise((resolve, reject) => {
            if (signal.aborted) {
                reject(new AbortedError("waitForElement", signal.reason));
                return;
            }
            let observer = null;
            const stop = () => {
                if (observer !== null) {
                    observer.disconnect();
                }
                signal.removeEventListener("abort", onAbort);
            };
            function onAbort() {
                stop();
                reject(new AbortedError("waitForElement", signal.reason));
            }
            signal.addEventListener("abort", onAbort);

            const immediate = probe();
            if (immediate) {
                stop();
                resolve(immediate);
                return;
            }
            observer = new MutationObserver((mutations) => {
                const found = probe(mutations);
                if (found) {
                    stop();
                    resolve(found);
                }
            });
            observer.observe(target, { subtree: true, childList: true });
        });
    }

    /**
     * The one shape every step of the unsend workflow needs: optionally click something,
     * then wait for a specific element to appear (or disappear), bounded both by a
     * timeout and by the run's abort signal, cleaning up whichever loses the race.
     *
     * @param {Element} target - subtree to observe
     * @param {function(MutationRecord[]=): (Element|null|undefined)} probe
     * @param {object} options
     * @param {AbortSignal} options.signal - the run's signal
     * @param {string} options.step - name used in log and error messages
     * @param {number} [options.timeoutMs] - 0 or omitted waits indefinitely
     * @param {Element} [options.clickTarget] - clicked once the observer is in place
     * @returns {Promise<Element>}
     */
    async function awaitElement(target, probe, { signal, step, timeoutMs = 0, clickTarget = null }) {
        // A child controller lets the timeout, a successful click and the parent all
        // tear the observer down through the same path.
        const local = new AbortController();
        const onParentAbort = () => local.abort(`${step} was aborted by the parent process`);
        signal.addEventListener("abort", onParentAbort);

        const pending = waitForElement(target, probe, local.signal);
        // The finally block below rejects `pending` whenever it did not win the race;
        // without a handler the browser would report that as an unhandled rejection.
        pending.catch(() => {});

        let timer = null;
        try {
            if (clickTarget !== null) {
                clickTarget.click();
                // Clicking can produce the element synchronously, in which case there is
                // nothing to wait for.
                const immediate = probe();
                if (immediate) {
                    return immediate;
                }
            }
            if (timeoutMs <= 0) {
                return await pending;
            }
            const expiry = new Promise((resolve, reject) => {
                timer = setTimeout(() => reject(new TimeoutError(step, timeoutMs)), timeoutMs);
            });
            return await Promise.race([pending, expiry]);
        } finally {
            clearTimeout(timer);
            local.abort(`${step} finished`);
            signal.removeEventListener("abort", onParentAbort);
        }
    }

    // -----------------------------------------------------------------------
    // 5. Thread probes
    // -----------------------------------------------------------------------

    /**
     * First scrollable descendant, depth first, in document order.
     *
     * @param {Element} parent
     * @param {Window} window
     * @returns {HTMLElement|null}
     */
    function findScrollableDescendant(parent, window) {
        for (const child of parent.children) {
            const overflowY = window.getComputedStyle(child).overflowY;
            const scrollable = (overflowY === "auto" || overflowY === "scroll") &&
                child.scrollHeight > child.clientHeight;
            if (scrollable) {
                return child;
            }
            const found = findScrollableDescendant(child, window);
            if (found !== null) {
                return found;
            }
        }
        return null;
    }

    /**
     * The scrollable element holding the open conversation.
     *
     * Instagram dropped role="grid" from the message list, so the conversation pagelet
     * is located by its data attribute and the scroll container is found underneath it.
     *
     * @param {Window} window
     * @returns {HTMLElement|null}
     */
    function findThreadScroller(window) {
        const conversation = window.document.querySelector(SELECTORS.conversation);
        return conversation === null ? null : findScrollableDescendant(conversation, window);
    }

    /**
     * The container whose direct children are the individual message rows.
     *
     * Instagram nests the rows several wrappers deep, and the wrapper names change. The
     * row container is however always the descendant with by far the most children, one
     * per message, so the shallow subtree is searched for exactly that.
     *
     * The search stops at any node wide enough to be the container itself: its children
     * are individual messages, so nothing bigger can be hiding inside. Descending into
     * them instead walks every message in the thread, which turns this lookup into the
     * most expensive thing the script does once a conversation has been paged back far.
     *
     * @param {Element} scroller
     * @returns {Element}
     */
    function findRowContainer(scroller) {
        let best = scroller;
        let bestCount = scroller.children.length;

        const search = (element, depth) => {
            if (depth > LIMITS.rowContainerDepth) {
                return;
            }
            for (const child of element.children) {
                const count = child.children.length;
                if (count > bestCount) {
                    best = child;
                    bestCount = count;
                }
                if (count <= LIMITS.rowContainerFanout) {
                    search(child, depth + 1);
                }
            }
        };
        search(scroller, 0);

        return best;
    }

    /**
     * Whether a message row is one of ours. Instagram right-aligns messages we sent by
     * putting justify-content: flex-end on some nested div, so the row is searched
     * breadth first for that.
     *
     * getComputedStyle forces a style recalculation and this runs for every candidate on
     * every scroll step, which made it the single most expensive thing the script did.
     * A message's author never changes, so the answer is cached on the row itself.
     *
     * @param {Element} row
     * @param {Window} window
     * @returns {boolean}
     */
    function isOwnMessage(row, window) {
        const cached = row.getAttribute(MARKER.own);
        if (cached !== null) {
            return cached === "1";
        }
        let own = false;
        // Breadth first, because the alignment sits on any branch around depth 5 and
        // stopping at the first match keeps the number of style reads down.
        const queue = [{ element: row, depth: 0 }];
        for (let index = 0; index < queue.length; index++) {
            const { element, depth } = queue[index];
            if (window.getComputedStyle(element).justifyContent === "flex-end") {
                own = true;
                break;
            }
            if (depth < LIMITS.senderDepth) {
                for (const child of element.children) {
                    queue.push({ element: child, depth: depth + 1 });
                }
            }
        }
        row.setAttribute(MARKER.own, own ? "1" : "0");
        return own;
    }

    /**
     * Whether a row is close enough to the viewport for Instagram to have rendered its
     * hover affordances.
     *
     * @param {Element} row
     * @returns {boolean}
     */
    function isRowVisible(row) {
        if (typeof row.checkVisibility === "function") {
            const visible = row.checkVisibility({
                visibilityProperty: true,
                contentVisibilityAuto: true,
                opacityProperty: true,
            });
            if (visible === false) {
                return false;
            }
        }
        const rect = row.getBoundingClientRect();
        // Tall rows (images, long text) can have a negative y while still being on
        // screen, so the bottom edge decides.
        return rect.height > 0 && rect.y + rect.height >= 0;
    }

    /**
     * Claims the next unprocessed message of ours that is currently on screen, marking
     * it so that it is not handed out twice.
     *
     * @param {Element} container - the row container
     * @param {AbortSignal} signal
     * @param {Window} window
     * @returns {Element|null}
     */
    function claimVisibleOwnMessage(container, signal, window) {
        if (container === null) {
            return null;
        }

        const candidates = [];
        for (const row of container.children) {
            // Cheap attribute tests first: they knock out most rows without touching
            // layout, and every row ruled out here stays ruled out for the whole run.
            if (row.hasAttribute(MARKER.ignore) || row.hasAttribute(MARKER.unsent)) {
                continue;
            }
            if (row.getAttribute(MARKER.own) === "0") {
                continue;
            }
            if (row.querySelector(SELECTORS.bubble) === null) {
                continue;
            }
            if (isOwnMessage(row, window) === false) {
                continue;
            }
            candidates.push(row);
        }

        // Work from the oldest row on screen upwards, matching the direction of the sweep.
        candidates.reverse();

        for (const row of candidates) {
            if (signal.aborted) {
                return null;
            }
            if (isRowVisible(row) === false) {
                continue;
            }
            row.setAttribute(MARKER.ignore, "");
            return row;
        }
        return null;
    }

    // -----------------------------------------------------------------------
    // 6. MessageRow
    // -----------------------------------------------------------------------

    /** The unsend workflow failed for one message; the run itself can continue. */
    class UnsendWorkflowError extends Error {
        constructor(message, options) {
            super(message, options);
            this.name = "UnsendWorkflowError";
        }
    }

    /**
     * @param {string} text
     * @returns {boolean} whether the text is a localised "Unsend"
     */
    function isUnsendLabel(text) {
        const normalized = text.trim().toLocaleLowerCase();
        return UNSEND_LABELS.some((label) => normalized === label);
    }

    /**
     * @param {Element} node
     * @returns {boolean} whether the node is the leaf that renders an "Unsend" label
     */
    function isUnsendLabelNode(node) {
        return isUnsendLabel(node.textContent) && node.firstChild?.nodeType === Node.TEXT_NODE;
    }

    /**
     * One message in the conversation, and the four-step dance needed to unsend it:
     * hover the row, open the "..." menu, pick "Unsend", confirm the dialog.
     *
     * Every step is driven through synthetic events because Instagram renders the
     * controls only in response to real interaction.
     */
    class MessageRow {

        /**
         * @param {Element} element - a direct child of the row container
         */
        constructor(element) {
            this.element = element;
        }

        /**
         * @readonly
         * @type {Document}
         */
        get document() {
            return this.element.ownerDocument;
        }

        /**
         * Runs the whole workflow. Resolves once Instagram has accepted the unsend, and
         * rejects with an UnsendWorkflowError otherwise, leaving the page in a state the
         * next message can start from.
         *
         * @param {AbortSignal} signal
         * @returns {Promise<void>}
         */
        async unsend(signal) {
            console.debug("MessageRow unsend", this.element);
            try {
                const actionButton = await this.#revealActionButton(signal);
                const unsendItem = await this.#openActionsMenu(actionButton, signal);
                const dialogButton = await this.#openConfirmDialog(unsendItem, signal);
                await this.#confirmUnsend(dialogButton, signal);
                this.element.setAttribute(MARKER.unsent, "");
            } catch (cause) {
                console.error(cause);
                this.element.setAttribute(MARKER.ignore, "");
                await this.#dismissOverlays();
                throw new UnsendWorkflowError("Failed to execute workflow for this message", { cause });
            }
        }

        /**
         * Step 1: make the "..." button appear.
         *
         * Hover events are unreliable here — React sometimes ignores the first one, and
         * the element that actually carries the listener moves between releases — so the
         * whole row and everything under it is sprayed, several times, before falling
         * back to watching for the button with a mutation observer.
         *
         * @param {AbortSignal} signal
         * @returns {Promise<Element>}
         */
        async #revealActionButton(signal) {
            console.debug("Workflow step 1: reveal the actions button", this.element);
            this.#dismissStaleOverlays();

            const hoverTargets = this.#hoverTargets();
            for (let attempt = 0; attempt < LIMITS.hoverAttempts; attempt++) {
                if (signal.aborted) {
                    throw new AbortedError("revealActionButton", signal.reason);
                }
                for (const target of hoverTargets) {
                    dispatchHover(target, HOVER_IN);
                }
                await sleep(TIMING.hoverSettle);

                const button = this.#findActionButton();
                if (button !== null) {
                    console.debug("Workflow step 1: found the actions button on attempt", attempt, button);
                    return button;
                }

                console.debug("Workflow step 1: attempt", attempt, "found nothing, retrying");
                dispatchHover(this.element, HOVER_OUT);
                await sleep(TIMING.hoverRetry);
            }

            // Hold the hover and give Instagram longer to render the button.
            for (const target of hoverTargets) {
                dispatchHover(target, HOVER_IN);
            }
            return awaitElement(this.element, () => this.#findActionButton(), {
                signal,
                step: "revealActionButton",
                timeoutMs: TIMING.actionButton,
            });
        }

        /**
         * The row itself plus every descendant down to LIMITS.hoverDepth, in document
         * order. React listens at intermediate levels (role=group, the flex-end wrapper),
         * and which level is the live one varies, so all of them get the events.
         *
         * @returns {Element[]}
         */
        #hoverTargets() {
            const targets = [this.element];
            const collect = (element, depth) => {
                if (depth > LIMITS.hoverDepth) {
                    return;
                }
                for (const child of element.children) {
                    targets.push(child);
                    collect(child, depth + 1);
                }
            };
            collect(this.element, 0);
            return targets;
        }

        /**
         * The "..." button inside this row, or null.
         *
         * The aria-label may sit on the button, on a wrapper or on a nested SVG title, so
         * whatever matches is walked up to the nearest clickable ancestor.
         *
         * @returns {Element|null}
         */
        #findActionButton() {
            for (const selector of SELECTORS.actionButton) {
                const match = this.element.querySelector(selector);
                if (match === null) {
                    continue;
                }
                const button = match.closest("[role=button]") || match.closest("button");
                if (button !== null && this.element.contains(button)) {
                    return button;
                }
                if (match.tagName === "BUTTON" || match.getAttribute("role") === "button") {
                    return match;
                }
            }
            return this.element.querySelector(SELECTORS.actionButtonFallback);
        }

        /**
         * Step 2: open the actions menu and locate its "Unsend" item.
         *
         * The menu is portalled to the end of the document rather than into the row, so
         * the whole body is observed. Newly added nodes are inspected first because that
         * is cheap; if the menu was already open the document is scanned instead.
         *
         * @param {Element} actionButton
         * @param {AbortSignal} signal
         * @returns {Promise<Element>}
         */
        #openActionsMenu(actionButton, signal) {
            console.debug("Workflow step 2: open the actions menu", actionButton);
            const document = this.document;
            const probe = (mutations) => {
                for (const added of addedElements(mutations || [])) {
                    const match = [...added.querySelectorAll("span,div")].find(isUnsendLabelNode);
                    if (match !== undefined) {
                        return match;
                    }
                }
                return [...document.querySelectorAll(SELECTORS.menuLabel)].find(isUnsendLabelNode) || null;
            };
            return awaitElement(document.body, probe, {
                signal,
                step: "openActionsMenu",
                timeoutMs: TIMING.actionsMenu,
                clickTarget: actionButton,
            });
        }

        /**
         * Step 3: pick "Unsend" and wait for the confirmation dialog.
         *
         * @param {Element} unsendItem
         * @param {AbortSignal} signal
         * @returns {Promise<Element>} the dialog's confirm button
         */
        #openConfirmDialog(unsendItem, signal) {
            console.debug("Workflow step 3: confirm dialog", unsendItem);
            const document = this.document;
            return awaitElement(document.body, () => document.querySelector(SELECTORS.dialogButton), {
                signal,
                step: "openConfirmDialog",
                clickTarget: unsendItem,
            });
        }

        /**
         * Step 4: confirm, and wait for the dialog to go away.
         *
         * @param {Element} dialogButton
         * @param {AbortSignal} signal
         * @returns {Promise<void>}
         */
        async #confirmUnsend(dialogButton, signal) {
            console.debug("Workflow step 4: confirm the unsend", dialogButton);
            const document = this.document;
            await awaitElement(
                document.body,
                () => document.querySelector(SELECTORS.dialogButton) === null,
                { signal, step: "confirmUnsend", clickTarget: dialogButton },
            );
        }

        /**
         * Closes anything a previous, failed workflow left open, so this message starts
         * from a clean page.
         */
        #dismissStaleOverlays() {
            const document = this.document;
            const staleDialog = document.querySelector(SELECTORS.dialog);
            if (staleDialog !== null) {
                console.debug("Dismissing a stale dialog");
                const closeButton = staleDialog.querySelector("button");
                if (closeButton !== null) {
                    closeButton.click();
                }
            }
            if (document.querySelector(SELECTORS.openMenu) !== null) {
                console.debug("Dismissing a stale menu");
                pressEscape(document);
            }
        }

        /**
         * Closes whatever this failed workflow left open. Instagram occasionally needs a
         * second Escape, and neither press is allowed to throw over the original error.
         *
         * @returns {Promise<void>}
         */
        async #dismissOverlays() {
            const document = this.document;
            try {
                for (let attempt = 0; attempt < 2; attempt++) {
                    if (attempt > 0 && document.querySelector(SELECTORS.dialog) === null) {
                        return;
                    }
                    pressEscape(document);
                    await sleep(TIMING.overlayDismiss);
                }
            } catch (ex) {
                console.error(ex);
            }
        }

    }

    // -----------------------------------------------------------------------
    // 7. MessageThread
    // -----------------------------------------------------------------------

    /** Outcome of one attempt to pull in an older page of messages. */
    const PageLoad = {
        /** Older messages were appended to the DOM. */
        GREW: "grew",
        /** We are pinned at the very top and Instagram offered nothing further. */
        END: "end",
        /** Instagram did not answer in time. Unknown, and worth retrying. */
        STALLED: "stalled",
        /** The run was cancelled. */
        ABORTED: "aborted",
    };

    /**
     * The open conversation: everything that involves scrolling, paging or searching the
     * message list, on top of a single scroll container.
     *
     * A scan cursor is kept between calls so that consecutive unsends resume where the
     * last one stopped instead of crawling back down from the newest message every time.
     */
    class MessageThread {

        /**
         * @param {Window} window
         * @returns {MessageThread}
         * @throws {Error} when the message list cannot be found
         */
        static attach(window) {
            const scroller = findThreadScroller(window);
            if (scroller === null) {
                throw new Error(
                    `Unable to find the message list (${SELECTORS.conversation}). ` +
                    "Instagram's markup has probably changed.",
                );
            }
            console.debug("MessageThread attached to", scroller);
            return new MessageThread(scroller);
        }

        /**
         * @param {Element} scroller - the scrollable element holding the conversation
         */
        #rowContainer = null;

        constructor(scroller) {
            this.scroller = scroller;
            this.window = scroller.ownerDocument.defaultView;
            this.cursor = null;
        }

        /**
         * Finds the next message of ours to unsend, scrolling as needed.
         *
         * The scan cursor is a frontier, not a hint: everything between the newest
         * message and the cursor has already been swept, so a scan resumes there and
         * only ever moves towards the oldest end. Restarting from the newest message on
         * every scan means re-crossing the entire loaded conversation before reaching
         * the point where work is actually happening, and that cost grows with every
         * page loaded.
         *
         * `fromNewest` asks for the full sweep anyway. It is worth paying for exactly
         * once, when the loader claims the thread is exhausted: a row can be missed
         * mid-run if Instagram had not rendered it as the scan passed over it.
         *
         * @param {AbortSignal} signal
         * @param {{fromNewest?: boolean}} [options]
         * @returns {Promise<MessageRow|null>}
         */
        async findNextOwnMessage(signal, { fromNewest = false } = {}) {
            // Cheapest case by far: something of ours is already on screen.
            const onScreen = this.#claimHere(signal);
            if (onScreen !== null) {
                return onScreen;
            }

            const { newest, oldest } = this.#scrollRange();
            // Step by most of a viewport. A sub-viewport step just re-tests the same screen.
            const step = Math.max(120, Math.floor(this.scroller.clientHeight * 0.8));
            let position = fromNewest || this.cursor === null
                ? newest
                : clamp(this.cursor, oldest, newest);
            console.debug(`findNextOwnMessage from=${position} to=${oldest} step=${step}`);

            while (position > oldest) {
                if (signal.aborted) {
                    return null;
                }
                const found = await this.#probeAt(position, signal);
                if (found !== null) {
                    return found;
                }
                position = Math.max(position - step, oldest);
            }
            // Always test the far end of the range as well.
            return signal.aborted ? null : this.#probeAt(oldest, signal);
        }

        /**
         * Pulls in one older page of messages.
         *
         * This never reports END merely because a fetch was slow: a request still in
         * flight is reported as STALLED so the caller can back off and try again.
         * Conflating "slow" with "finished" is what made long threads stop early and
         * claim they were done.
         *
         * @param {AbortSignal} signal
         * @returns {Promise<string>} one of PageLoad
         */
        async loadOlderPage(signal) {
            const scroller = this.scroller;
            const reversed = this.#isReversed();
            const oldest = () => this.#scrollRange(reversed).oldest;
            const pin = () => {
                scroller.scrollTop = oldest();
                scroller.dispatchEvent(new this.window.Event("scroll"));
            };

            const beforeHeight = scroller.scrollHeight;
            const beforeRows = this.#rowCount();
            // Height alone is unreliable while images settle, so count rows as well.
            const grew = () => scroller.scrollHeight > beforeHeight + 4 || this.#rowCount() > beforeRows;

            pin();

            // Phase 1 — give Instagram a chance to react to us sitting at the top.
            let loaderSeen = false;
            const appearUntil = Date.now() + TIMING.loaderAppear;
            while (Date.now() < appearUntil) {
                if (signal.aborted) {
                    return PageLoad.ABORTED;
                }
                if (grew()) {
                    return PageLoad.GREW;
                }
                if (this.#findVisibleLoader() !== null) {
                    loaderSeen = true;
                    break;
                }
                pin();
                await sleep(TIMING.loaderAppearPoll);
            }

            // Phase 2 — a spinner is up, so a request really is in flight. Wait it out.
            if (loaderSeen) {
                const clearUntil = Date.now() + TIMING.loaderClear;
                while (Date.now() < clearUntil) {
                    if (signal.aborted) {
                        return PageLoad.ABORTED;
                    }
                    if (grew()) {
                        return PageLoad.GREW;
                    }
                    if (this.#findVisibleLoader() === null) {
                        break;
                    }
                    await sleep(TIMING.loaderClearPoll);
                }
                return grew() ? PageLoad.GREW : PageLoad.STALLED;
            }

            // Phase 3 — no spinner ever appeared.
            if (grew()) {
                return PageLoad.GREW;
            }
            // Pinned at the top, nothing loading, nothing new: probably the start of the
            // thread. The caller still confirms this several times before believing it.
            return Math.abs(scroller.scrollTop - oldest()) <= 5 ? PageLoad.END : PageLoad.STALLED;
        }

        /**
         * Keeps the scan cursor after the DOM shrinks, clamping it into the new range.
         *
         * Discarding it instead sends the next scan back to the newest message, which
         * then has to crawl all the way back to where it was working.
         */
        clampCursor() {
            if (this.cursor === null) {
                return;
            }
            const { newest, oldest } = this.#scrollRange();
            this.cursor = clamp(this.cursor, oldest, newest);
        }

        /**
         * Scrolls to a position and tests what is now on screen.
         *
         * @param {number} position
         * @param {AbortSignal} signal
         * @returns {Promise<MessageRow|null>}
         */
        async #probeAt(position, signal) {
            this.cursor = position;
            this.scroller.scrollTop = position;
            this.scroller.dispatchEvent(new this.window.Event("scroll"));
            await sleep(TIMING.scanSettle);
            return this.#claimHere(signal);
        }

        /**
         * Claims a message of ours from whatever is currently rendered. A broken lookup
         * must not abort the run, so failures are logged and reported as "nothing here".
         *
         * @param {AbortSignal} signal
         * @returns {MessageRow|null}
         */
        #claimHere(signal) {
            try {
                const element = claimVisibleOwnMessage(this.#rows, signal, this.window);
                return element === null ? null : new MessageRow(element);
            } catch (ex) {
                console.error(ex);
                return null;
            }
        }

        /**
         * @returns {boolean} whether the list is laid out newest-first (column-reverse)
         */
        #isReversed() {
            return this.window.getComputedStyle(this.scroller).flexDirection === "column-reverse";
        }

        /**
         * The scroll positions of both ends of the loaded thread.
         *
         * Instagram lays the list out column-reverse, so scrollTop is 0 at the newest
         * message and negative towards older ones, while a normal layout runs from a
         * positive maximum down to 0. Both are described here as "newest -> oldest,
         * decreasing", which is the only thing the rest of the class needs to know.
         *
         * @param {boolean} [reversed]
         * @returns {{newest: number, oldest: number}}
         */
        #scrollRange(reversed = this.#isReversed()) {
            const distance = Math.max(0, this.scroller.scrollHeight - this.scroller.clientHeight);
            return reversed ? { newest: 0, oldest: -distance } : { newest: distance, oldest: 0 };
        }

        /**
         * The container holding the message rows, resolved once and kept.
         *
         * Finding it means walking the scroller's subtree, and it is needed on every
         * probe and on every poll of a page load. React keeps the same container across
         * page loads, so it is only looked up again if it goes away or comes back empty.
         *
         * @type {Element}
         */
        get #rows() {
            const cached = this.#rowContainer;
            if (cached !== null && cached.isConnected && cached.children.length > 0) {
                return cached;
            }
            this.#rowContainer = findRowContainer(this.scroller);
            return this.#rowContainer;
        }

        /**
         * @returns {number} how many message rows are currently in the DOM
         */
        #rowCount() {
            const container = this.#rows;
            return container === null ? 0 : container.children.length;
        }

        /**
         * A spinner rendered inside (or just outside) the scroll viewport. Instagram
         * keeps offscreen progressbars around for unrelated things, so position matters.
         *
         * @returns {Element|null}
         */
        #findVisibleLoader() {
            const bounds = this.scroller.getBoundingClientRect();
            for (const loader of this.scroller.querySelectorAll(SELECTORS.loader)) {
                const rect = loader.getBoundingClientRect();
                const near = rect.y >= bounds.y - 100 && rect.y <= bounds.y + bounds.height + 100;
                if (rect.height > 0 && near) {
                    return loader;
                }
            }
            return null;
        }

    }

    // -----------------------------------------------------------------------
    // 8. UnsendRun
    // -----------------------------------------------------------------------

    /** How a run ended. Each value maps to one closing status message. */
    const Outcome = {
        DONE: "done",
        ABORTED: "aborted",
        FAILURES: "failures",
        THROTTLED: "throttled",
        ERROR: "error",
    };

    /**
     * Sweeps a thread from the newest message backwards, unsending one message at a time
     * and reporting progress to whoever is displaying it.
     *
     * There is deliberately no "load every page first" phase. Older pages are fetched
     * only once the loaded region has been cleared, so the DOM stays at roughly one
     * viewport, the scan stays cheap no matter how long the thread is, and a slow page
     * fetch stalls the run instead of silently ending it.
     */
    class UnsendRun {

        /**
         * @param {Window} window
         * @param {{onStatus: function(string), onProgress: function(object)}} listener
         */
        constructor(window, listener) {
            this.window = window;
            this.listener = listener;
            this.thread = null;
            this.unsentCount = 0;
            this.pagesLoaded = 0;
            this.consecutiveFailures = 0;
            this.lastUnsendAt = null;
            this.abortController = null;
            this.started = false;
        }

        /**
         * @returns {boolean}
         */
        isRunning() {
            return this.started &&
                this.abortController !== null &&
                this.abortController.signal.aborted === false;
        }

        /** Asks the current run to stop at the next checkpoint. */
        stop() {
            console.debug("UnsendRun stop");
            this.#setStatus("Stopping…");
            if (this.abortController !== null) {
                this.abortController.abort("UnsendRun stopped");
            }
        }

        /** Clears the counters between conversations. */
        reset() {
            this.unsentCount = 0;
            this.pagesLoaded = 0;
            this.consecutiveFailures = 0;
            this.lastUnsendAt = null;
            this.#reportProgress();
            this.#setStatus("Ready");
        }

        /**
         * Runs to completion: unsend everything reachable, or stop trying and explain why.
         *
         * @returns {Promise<void>}
         */
        async start() {
            console.debug("UnsendRun start");
            this.unsentCount = 0;
            this.pagesLoaded = 0;
            this.consecutiveFailures = 0;
            this.lastUnsendAt = null;
            this.started = true;
            this.abortController = new AbortController();
            this.#reportProgress();
            this.#clearMarkers();

            let outcome = Outcome.DONE;
            try {
                this.thread = MessageThread.attach(this.window);
                // Let React finish hydrating the thread before the first scan.
                this.#setStatus("Reading the conversation…");
                await sleep(TIMING.hydrate);
                outcome = await this.#sweep();
            } catch (ex) {
                console.error(ex);
                outcome = Outcome.ERROR;
            }

            this.#setStatus(this.#summarize(outcome));
            this.started = false;
        }

        /**
         * Unsend, then load older, then repeat. Iterative on purpose: recursing once per
         * message builds a promise chain thousands deep on long threads.
         *
         * @returns {Promise<string>} one of Outcome
         */
        async #sweep() {
            const signal = this.abortController.signal;
            let endConfirmations = 0;
            let stalls = 0;

            while (signal.aborted === false) {
                if (this.consecutiveFailures >= LIMITS.consecutiveFailures) {
                    return Outcome.FAILURES;
                }

                this.#setStatus(`Looking for your next message… (${this.#formattedCount()} unsent)`);
                const message = await this.#findMessage();
                if (signal.aborted) {
                    return Outcome.ABORTED;
                }

                if (message !== null) {
                    endConfirmations = 0;
                    stalls = 0;
                    await this.#unsendOne(message);
                    continue;
                }

                // Nothing of ours left in the loaded region, so pull in an older page.
                this.#setStatus("Loading older messages…");
                let result;
                try {
                    result = await this.thread.loadOlderPage(signal);
                } catch (ex) {
                    console.error(ex);
                    result = PageLoad.STALLED;
                }
                if (signal.aborted || result === PageLoad.ABORTED) {
                    return Outcome.ABORTED;
                }

                if (result === PageLoad.GREW) {
                    this.pagesLoaded++;
                    this.#reportProgress();
                    endConfirmations = 0;
                    stalls = 0;
                    continue;
                }

                if (result === PageLoad.STALLED) {
                    stalls++;
                    if (stalls > LIMITS.stalls) {
                        return Outcome.THROTTLED;
                    }
                    await this.#countdown(
                        backoffDelay(stalls, LIMITS.stallBackoff),
                        `Instagram is throttling. Retrying in %s (${stalls}/${LIMITS.stalls})…`,
                    );
                    continue;
                }

                // PageLoad.END. Before counting that, sweep the whole loaded thread
                // once: scans only ever move away from the newest message, so this is
                // where a row that Instagram had not rendered in time gets picked up.
                this.#setStatus("Checking for messages we scrolled past…");
                const missed = await this.#findMessage({ fromNewest: true });
                if (signal.aborted) {
                    return Outcome.ABORTED;
                }
                if (missed !== null) {
                    endConfirmations = 0;
                    stalls = 0;
                    await this.#unsendOne(missed);
                    continue;
                }

                // A slow fetch looks exactly like the top of the thread, so only believe
                // it after several confirmations in a row.
                endConfirmations++;
                if (endConfirmations >= LIMITS.endConfirmations) {
                    return Outcome.DONE;
                }
                await this.#countdown(
                    1500 * endConfirmations,
                    `Checking for older messages, %s (${endConfirmations}/${LIMITS.endConfirmations})…`,
                );
            }

            return Outcome.ABORTED;
        }

        /**
         * Looks for the next message to unsend. A broken lookup must not end the run, so
         * failures are logged and reported as "nothing found", which sends the sweep on
         * to loading an older page.
         *
         * @param {{fromNewest?: boolean}} [options] - forwarded to the thread
         * @returns {Promise<MessageRow|null>}
         */
        async #findMessage(options) {
            try {
                return await this.thread.findNextOwnMessage(this.abortController.signal, options);
            } catch (ex) {
                console.error(ex);
                return null;
            }
        }

        /**
         * Unsends one message, absorbing the two ways Instagram says no: an outright
         * failure of the workflow, and a silent rate limit where the row reappears.
         *
         * @param {MessageRow} message
         * @returns {Promise<void>}
         */
        async #unsendOne(message) {
            const signal = this.abortController.signal;
            const element = message.element;
            try {
                await this.#pace();
                if (signal.aborted) {
                    return;
                }

                this.#setStatus(`Unsending message #${(this.unsentCount + 1).toLocaleString()}…`);
                await message.unsend(signal);
                if (signal.aborted) {
                    return;
                }

                // Instagram removes the row optimistically and restores it if the server
                // rejected the mutation, so confirm the message really went away.
                await sleep(TIMING.unsendSettle);
                const restored = element.isConnected &&
                    element.querySelector(SELECTORS.bubble) !== null;
                if (restored) {
                    console.debug("The message survived the unsend, treating it as a rate limit");
                    element.removeAttribute(MARKER.unsent);
                    await this.#retryLater(element, LIMITS.rateLimitBackoff, "Rate limited. Backing off %s…");
                    return;
                }

                this.lastUnsendAt = Date.now();
                this.unsentCount++;
                this.consecutiveFailures = 0;
                this.#reportProgress();
                // The DOM shrank. Clamp the scan cursor into the new range rather than
                // dropping it, so the next scan resumes here instead of at the newest message.
                this.thread.clampCursor();
            } catch (ex) {
                console.error(ex);
                await this.#retryLater(
                    element,
                    LIMITS.workflowBackoff,
                    `Workflow failed (%d/${LIMITS.consecutiveFailures}). Retrying in %s…`,
                );
            }
        }

        /**
         * Counts a failure, un-marks the row so it is tried again, and waits out the
         * backoff for this many consecutive failures.
         *
         * @param {Element} element
         * @param {{baseMs: number, capMs: number}} curve
         * @param {string} template - "%d" is the failure count, "%s" the remaining time
         * @returns {Promise<void>}
         */
        async #retryLater(element, curve, template) {
            element.removeAttribute(MARKER.ignore);
            this.consecutiveFailures++;
            await this.#countdown(
                backoffDelay(this.consecutiveFailures, curve),
                template.replace("%d", String(this.consecutiveFailures)),
            );
        }

        /**
         * Randomised 1-2s spacing between unsends, so the run does not look like a script
         * hammering the API.
         *
         * @returns {Promise<void>}
         */
        async #pace() {
            if (this.lastUnsendAt === null) {
                return;
            }
            const elapsed = Date.now() - this.lastUnsendAt;
            const gap = TIMING.unsendGap + Math.floor(Math.random() * TIMING.unsendGap);
            if (elapsed >= gap) {
                return;
            }
            await this.#countdown(gap - elapsed, "Pacing requests, %s…");
        }

        /**
         * Abort-aware wait that counts down in the status line.
         *
         * @param {number} totalMs
         * @param {string} template - "%s" is replaced with the remaining time
         * @returns {Promise<void>}
         */
        async #countdown(totalMs, template) {
            const until = Date.now() + totalMs;
            while (Date.now() < until) {
                if (this.abortController.signal.aborted) {
                    return;
                }
                const remaining = Math.max(1, Math.ceil((until - Date.now()) / 1000));
                this.#setStatus(template.replace("%s", `${remaining}s`));
                await sleep(clamp(until - Date.now(), 50, TIMING.countdownTick));
            }
        }

        /**
         * Removes the markers left by earlier runs so nothing is skipped this time. The
         * cached sender flag goes too, in case React reused a node for another message.
         */
        #clearMarkers() {
            const document = this.window.document;
            for (const attribute of [MARKER.ignore, MARKER.own]) {
                for (const element of document.querySelectorAll(`[${attribute}]`)) {
                    element.removeAttribute(attribute);
                }
            }
        }

        /**
         * @param {string} outcome - one of Outcome
         * @returns {string} the closing status message
         */
        #summarize(outcome) {
            const count = this.#formattedCount();
            switch (outcome) {
                case Outcome.ABORTED:
                    return `Stopped. ${count} message(s) unsent.`;
                case Outcome.FAILURES:
                    return `Stopped after ${LIMITS.consecutiveFailures} failures in a row. ` +
                        `${count} unsent — try again in a few minutes.`;
                case Outcome.THROTTLED:
                    return `Instagram stopped serving older messages. ${count} unsent — ` +
                        "reload the page and run again to continue.";
                case Outcome.ERROR:
                    return `Errored after ${count} message(s). See the browser console.`;
                default:
                    return `Done. ${count} message(s) unsent.`;
            }
        }

        /**
         * @returns {string}
         */
        #formattedCount() {
            return this.unsentCount.toLocaleString();
        }

        /**
         * @param {string} text
         */
        #setStatus(text) {
            this.listener.onStatus(text);
        }

        #reportProgress() {
            this.listener.onProgress({ unsent: this.unsentCount, pages: this.pagesLoaded });
        }

    }

    // -----------------------------------------------------------------------
    // 9. Panel view
    // -----------------------------------------------------------------------

    /** Attribute used to find the panel's live parts; see PANEL_REFS. */
    const REF = "data-idmu-ref";

    /** The parts of the panel the controller updates, keyed by ref name. */
    const PANEL_REFS = ["action", "status", "hint", "unsent", "pages", "elapsed"];

    const IDMU_STYLESHEET = `
#idmu-root, #idmu-root * { box-sizing: border-box; margin: 0; padding: 0; }
#idmu-root {
	position: fixed;
	top: 84px;
	right: 24px;
	z-index: 2147483000;
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
	-webkit-font-smoothing: antialiased;
}
.idmu-panel {
	width: 292px;
	border-radius: 16px;
	overflow: hidden;
	color: #101014;
	background: rgba(255, 255, 255, 0.92);
	border: 1px solid rgba(0, 0, 0, 0.08);
	box-shadow: 0 16px 40px rgba(0, 0, 0, 0.18), 0 2px 8px rgba(0, 0, 0, 0.06);
	backdrop-filter: blur(20px) saturate(180%);
	-webkit-backdrop-filter: blur(20px) saturate(180%);
	user-select: none;
}
.idmu-header {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 13px 14px 11px;
	cursor: grab;
	touch-action: none;
}
.idmu-header:active { cursor: grabbing; }
.idmu-mark {
	flex: 0 0 auto;
	width: 30px;
	height: 30px;
	border-radius: 9px;
	display: grid;
	place-items: center;
	color: #fff;
	font-size: 11px;
	font-weight: 800;
	letter-spacing: 0.02em;
	background: linear-gradient(135deg, #833ab4, #e1306c 55%, #fd8d32);
}
.idmu-titles { min-width: 0; }
.idmu-title { font-size: 13px; font-weight: 700; line-height: 1.2; }
.idmu-credit {
	margin-top: 2px;
	font-size: 11px;
	line-height: 1.35;
	opacity: 0.62;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.idmu-credit a { color: inherit; text-decoration: none; border-bottom: 1px solid currentColor; }
.idmu-credit a:hover { opacity: 1; }
.idmu-stats {
	display: grid;
	grid-template-columns: repeat(3, 1fr);
	gap: 1px;
	background: rgba(128, 128, 128, 0.2);
	border-top: 1px solid rgba(128, 128, 128, 0.18);
	border-bottom: 1px solid rgba(128, 128, 128, 0.18);
}
.idmu-stat { padding: 9px 6px; text-align: center; background: rgba(255, 255, 255, 0.62); }
.idmu-stat-value { font-size: 15px; font-weight: 700; line-height: 1.1; font-variant-numeric: tabular-nums; }
.idmu-stat-label { margin-top: 3px; font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.55; }
.idmu-track { height: 3px; background: rgba(128, 128, 128, 0.2); overflow: hidden; display: none; }
#idmu-root.idmu-root--running .idmu-track { display: block; }
.idmu-bar {
	height: 100%;
	width: 36%;
	background: linear-gradient(90deg, #833ab4, #e1306c, #fd8d32);
	animation: idmu-slide 1.4s ease-in-out infinite;
}
@keyframes idmu-slide {
	0% { transform: translateX(-110%); }
	100% { transform: translateX(320%); }
}
.idmu-body { display: grid; gap: 9px; padding: 12px 14px 13px; }
.idmu-action {
	width: 100%;
	border: 0;
	border-radius: 10px;
	padding: 10px 12px;
	font-family: inherit;
	font-size: 13px;
	font-weight: 700;
	color: #fff;
	cursor: pointer;
	background: linear-gradient(135deg, #833ab4, #e1306c 60%, #fd8d32);
	transition: filter 0.15s ease, transform 0.1s ease;
}
.idmu-action:hover { filter: brightness(1.08); }
.idmu-action:active { transform: translateY(1px); }
.idmu-action--stop { background: linear-gradient(135deg, #c92a2a, #fa383e); }
.idmu-status {
	display: flex;
	align-items: center;
	gap: 7px;
	min-height: 34px;
	font-size: 11.5px;
	line-height: 1.45;
	opacity: 0.78;
}
.idmu-dot { flex: 0 0 auto; width: 6px; height: 6px; border-radius: 50%; background: #8e8e93; }
#idmu-root.idmu-root--running .idmu-dot { background: #e1306c; animation: idmu-pulse 1.1s ease-in-out infinite; }
@keyframes idmu-pulse {
	0%, 100% { opacity: 1; transform: scale(1); }
	50% { opacity: 0.3; transform: scale(0.75); }
}
.idmu-status--error { color: #fa383e; opacity: 1; }
.idmu-hint { font-size: 10.5px; text-align: center; opacity: 0.45; }
#idmu-overlay {
	position: fixed;
	inset: 0;
	z-index: 2147482000;
	display: none;
	background: rgba(0, 0, 0, 0.45);
	backdrop-filter: blur(2px);
	-webkit-backdrop-filter: blur(2px);
}
#idmu-overlay.idmu-overlay--on { display: block; }
@media (prefers-color-scheme: dark) {
	.idmu-panel { color: #f2f2f5; background: rgba(24, 24, 27, 0.92); border-color: rgba(255, 255, 255, 0.1); }
	.idmu-stat { background: rgba(32, 32, 36, 0.62); }
}
@media (prefers-reduced-motion: reduce) {
	.idmu-bar, #idmu-root.idmu-root--running .idmu-dot { animation: none; }
}
`;

    /**
     * Adds IDMU's stylesheet to the document, once.
     *
     * @param {Document} document
     */
    function injectStylesheet(document) {
        if (document.getElementById("idmu-style") !== null) {
            return;
        }
        const style = createElement(document, "style", { id: "idmu-style" });
        style.textContent = IDMU_STYLESHEET;
        (document.head || document.documentElement).appendChild(style);
    }

    /**
     * One of the three counters in the panel header.
     *
     * @param {Document} document
     * @param {string} value
     * @param {string} label
     * @param {string} ref - PANEL_REFS entry the controller updates
     * @returns {Element}
     */
    function createStat(document, value, label, ref) {
        return createElement(document, "div", { className: "idmu-stat" }, [
            createElement(document, "div", { className: "idmu-stat-value", text: value, attrs: { [REF]: ref } }),
            createElement(document, "div", { className: "idmu-stat-label", text: label }),
        ]);
    }

    /**
     * Builds the panel: a draggable header with the author credit, live counters, an
     * indeterminate progress bar, the action button and the status line.
     *
     * @param {Document} document
     * @returns {Element} the #idmu-root wrapper
     */
    function createPanel(document) {
        const credit = createElement(document, "div", {
            className: "idmu-credit",
            text: `by ${AUTHOR.name} · `,
        }, [
            createElement(document, "a", {
                text: AUTHOR.handle,
                attrs: { href: AUTHOR.url, target: "_blank", rel: "noopener noreferrer" },
            }),
        ]);

        const header = createElement(document, "div", { className: "idmu-header" }, [
            createElement(document, "div", { className: "idmu-mark", text: "DM" }),
            createElement(document, "div", { className: "idmu-titles" }, [
                createElement(document, "div", { className: "idmu-title", text: "DM Unsender" }),
                credit,
            ]),
        ]);

        const stats = createElement(document, "div", { className: "idmu-stats" }, [
            createStat(document, "0", "Unsent", "unsent"),
            createStat(document, "0", "Pages", "pages"),
            createStat(document, "0:00", "Elapsed", "elapsed"),
        ]);

        const track = createElement(document, "div", { className: "idmu-track" }, [
            createElement(document, "div", { className: "idmu-bar" }),
        ]);

        const body = createElement(document, "div", { className: "idmu-body" }, [
            createElement(document, "button", {
                className: "idmu-action",
                text: "Unsend all DMs",
                attrs: { type: "button", [REF]: "action" },
            }),
            createElement(document, "div", { className: "idmu-status" }, [
                createElement(document, "span", { className: "idmu-dot" }),
                createElement(document, "span", { text: "Ready", attrs: { [REF]: "status" } }),
            ]),
            createElement(document, "div", {
                className: "idmu-hint",
                text: "Open a conversation to begin",
                attrs: { [REF]: "hint" },
            }),
        ]);

        return createElement(document, "div", { id: "idmu-root" }, [
            createElement(document, "div", { className: "idmu-panel" }, [header, stats, track, body]),
        ]);
    }

    /**
     * The scrim that blocks interaction with Instagram while a run is in progress.
     *
     * @param {Document} document
     * @returns {Element}
     */
    function createOverlay(document) {
        const overlay = createElement(document, "div", { id: "idmu-overlay" });
        overlay.tabIndex = 0;
        return overlay;
    }

    // -----------------------------------------------------------------------
    // 10. ControlPanel
    // -----------------------------------------------------------------------

    /**
     * The panel's behaviour: it owns the run, mirrors its status and counters, keeps a
     * per-conversation total, and makes sure Instagram receives neither clicks nor keys
     * while a run is in progress.
     */
    class ControlPanel {

        /**
         * Builds the panel, puts it on the page and starts watching for navigation.
         *
         * @param {Window} window
         * @returns {ControlPanel}
         */
        static mount(window) {
            const document = window.document;
            injectStylesheet(document);

            const overlay = createOverlay(document);
            document.body.appendChild(overlay);

            const root = createPanel(document);
            const panel = new ControlPanel(document, root, overlay);
            document.body.appendChild(root);

            panel.#restorePosition();
            panel.#syncWithRoute();
            return panel;
        }

        #document;
        #root;
        #overlay;
        #refs;
        #run;
        #observer;
        #startedAt = null;
        #timer = null;
        #threadPath = null;

        /**
         * @param {Document} document
         * @param {Element} root - the #idmu-root wrapper
         * @param {Element} overlay
         */
        constructor(document, root, overlay) {
            this.#document = document;
            this.#root = root;
            this.#overlay = overlay;
            this.#refs = Object.fromEntries(
                PANEL_REFS.map((name) => [name, root.querySelector(`[${REF}=${name}]`)]),
            );
            this.#run = new UnsendRun(this.window, {
                onStatus: (text) => this.#showStatus(text),
                onProgress: (progress) => this.#showProgress(progress),
            });

            this.#enableDragging(root.querySelector(".idmu-header"));
            this.#refs.action.addEventListener("click", () => this.#toggle());
            document.addEventListener("keydown", (event) => this.#lockKeyboard(event), true);
            document.addEventListener("keyup", (event) => this.#lockKeyboard(event), true);

            this.#observer = new MutationObserver(() => this.#syncWithRoute());
            this.#observer.observe(document.body, { childList: true });
        }

        /**
         * @readonly
         * @type {Element}
         */
        get root() {
            return this.#root;
        }

        /**
         * @readonly
         * @type {Window}
         */
        get window() {
            return this.#document.defaultView;
        }

        /** Starts a run, or stops the one in progress. */
        #toggle() {
            if (this.#run.isRunning()) {
                console.debug("User asked for unsending to stop");
                this.#run.stop();
            } else {
                console.debug("User asked for unsending to start; Instagram will be locked in the meantime");
                this.#startRun();
            }
        }

        /**
         * Locks the page, runs, then unlocks it whatever happened.
         *
         * @returns {Promise<void>}
         */
        async #startRun() {
            if (this.#run.isRunning()) {
                return;
            }
            this.#startedAt = Date.now();
            this.#root.classList.add("idmu-root--running");
            this.#overlay.classList.add("idmu-overlay--on");
            this.#overlay.focus();
            this.#refs.action.textContent = "Stop";
            this.#refs.action.classList.add("idmu-action--stop");
            this.#refs.status.classList.remove("idmu-status--error");
            this.#refs.hint.textContent = "Press Esc to stop · keep this tab open";
            this.#startTimer();
            // Instagram re-renders constantly during a run; route watching resumes after.
            this.#observer.disconnect();

            try {
                await this.#run.start();
            } catch (ex) {
                console.error(ex);
                this.#refs.status.classList.add("idmu-status--error");
                this.#refs.status.textContent = "Something went wrong — check the browser console.";
            } finally {
                this.#endRun();
            }
        }

        /** Unlocks the page and files away what the run achieved. */
        #endRun() {
            console.debug("ControlPanel run finished");
            this.#root.classList.remove("idmu-root--running");
            this.#overlay.classList.remove("idmu-overlay--on");
            this.#refs.action.textContent = "Unsend all DMs";
            this.#refs.action.classList.remove("idmu-action--stop");
            this.#stopTimer();
            this.#addToThreadTotal(this.#run.unsentCount);
            this.#refreshHint();
            this.#observer.observe(this.#document.body, { childList: true });
        }

        /**
         * @param {string} text
         */
        #showStatus(text) {
            this.#refs.status.textContent = text;
        }

        /**
         * @param {{unsent: number, pages: number}} progress
         */
        #showProgress(progress) {
            if (typeof progress.unsent === "number") {
                this.#refs.unsent.textContent = progress.unsent.toLocaleString();
            }
            if (typeof progress.pages === "number") {
                this.#refs.pages.textContent = progress.pages.toLocaleString();
            }
        }

        #startTimer() {
            this.#stopTimer();
            this.#tickElapsed();
            this.#timer = this.window.setInterval(() => this.#tickElapsed(), 1000);
        }

        #stopTimer() {
            if (this.#timer !== null) {
                this.window.clearInterval(this.#timer);
                this.#timer = null;
            }
        }

        #tickElapsed() {
            if (this.#startedAt === null) {
                return;
            }
            this.#refs.elapsed.textContent = formatElapsed(Date.now() - this.#startedAt);
        }

        /**
         * @readonly
         * @type {string} localStorage key holding the total for the open conversation
         */
        get #totalKey() {
            return STORAGE.threadTotal(this.window.location.pathname);
        }

        /**
         * @param {number} count
         */
        #addToThreadTotal(count) {
            if (count <= 0) {
                return;
            }
            const key = this.#totalKey;
            preferences.write(this.window, key, String(preferences.readCount(this.window, key) + count));
        }

        #refreshHint() {
            const total = preferences.readCount(this.window, this.#totalKey);
            this.#refs.hint.textContent = total > 0
                ? `${total.toLocaleString()} unsent in this chat so far`
                : "Very long threads may need more than one run";
        }

        /**
         * Makes the panel draggable by its header, keeping it inside the viewport and
         * remembering where it was left.
         *
         * @param {Element} header
         */
        #enableDragging(header) {
            let dragging = false;
            let offsetX = 0;
            let offsetY = 0;

            header.addEventListener("pointerdown", (event) => {
                if (event.button !== 0) {
                    return;
                }
                const rect = this.#root.getBoundingClientRect();
                offsetX = event.clientX - rect.left;
                offsetY = event.clientY - rect.top;
                dragging = true;
                header.setPointerCapture(event.pointerId);
                event.preventDefault();
            });

            header.addEventListener("pointermove", (event) => {
                if (dragging === false) {
                    return;
                }
                const maxLeft = Math.max(8, this.window.innerWidth - this.#root.offsetWidth - 8);
                const maxTop = Math.max(8, this.window.innerHeight - this.#root.offsetHeight - 8);
                this.#moveTo(
                    `${clamp(event.clientX - offsetX, 8, maxLeft)}px`,
                    `${clamp(event.clientY - offsetY, 8, maxTop)}px`,
                );
            });

            const endDrag = (event) => {
                if (dragging === false) {
                    return;
                }
                dragging = false;
                try {
                    header.releasePointerCapture(event.pointerId);
                } catch (ex) {
                    console.debug("IDMU: releasePointerCapture failed", ex);
                }
                preferences.write(this.window, STORAGE.panelPosition, JSON.stringify({
                    left: this.#root.style.left,
                    top: this.#root.style.top,
                }));
            };
            header.addEventListener("pointerup", endDrag);
            header.addEventListener("pointercancel", endDrag);
        }

        /**
         * @param {string} left - a CSS length
         * @param {string} top - a CSS length
         */
        #moveTo(left, top) {
            this.#root.style.left = left;
            this.#root.style.top = top;
            // The stylesheet pins the panel to the right; an explicit left has to win.
            this.#root.style.right = "auto";
        }

        #restorePosition() {
            const stored = preferences.readJSON(this.window, STORAGE.panelPosition);
            if (stored && stored.left && stored.top) {
                this.#moveTo(stored.left, stored.top);
            }
        }

        /**
         * Shows the panel on conversation pages and hides it everywhere else, and keeps
         * the mutation observer attached to Instagram's app root now that it exists.
         *
         * Instagram is a single-page app, so this is the only notification of navigation
         * the script gets.
         */
        #syncWithRoute() {
            const appRoot = this.#document.querySelector(SELECTORS.appRoot);
            if (appRoot !== null) {
                this.#observer.disconnect();
                this.#observer.observe(appRoot, { childList: true, attributes: true });
            }

            const pathname = this.window.location.pathname;
            if (pathname.startsWith(THREAD_PATH_PREFIX) === false) {
                this.#root.style.display = "none";
                if (this.#run.isRunning()) {
                    this.#run.stop();
                }
                return;
            }

            this.#root.style.display = "";
            // Only reset when the conversation actually changes, so the numbers from the
            // last run stay on screen afterwards.
            if (this.#threadPath !== pathname && this.#run.isRunning() === false) {
                this.#threadPath = pathname;
                this.#startedAt = null;
                this.#refs.elapsed.textContent = "0:00";
                this.#run.reset();
                this.#refreshHint();
            }
        }

        /**
         * While a run is in progress Instagram must not receive keyboard input, or a
         * stray key can navigate away mid-unsend. Escape is reserved for stopping.
         *
         * Only real key presses count. The unsend workflow presses Escape itself to
         * close a menu or dialog a failed message left open, and swallowing that both
         * ended the run on the first recoverable failure and stopped the key from
         * reaching Instagram, so the overlay it was meant to dismiss stayed open.
         *
         * @param {KeyboardEvent} event
         */
        #lockKeyboard(event) {
            if (this.#run.isRunning() === false || event.isTrusted === false) {
                return;
            }
            if (event.type === "keydown" && event.key === "Escape") {
                this.#run.stop();
            }
            event.stopImmediatePropagation();
            event.preventDefault();
        }

    }

    // -----------------------------------------------------------------------
    // 11. Bootstrap
    // -----------------------------------------------------------------------

    /**
     * Entry point: puts the panel on the page.
     *
     * @param {Window} window
     * @returns {ControlPanel}
     */
    function main(window) {
        if (!window || !window.document || !window.document.body) {
            throw new TypeError("main(window) needs a window whose document has a body");
        }
        return ControlPanel.mount(window);
    }

    if (typeof window !== "undefined" && window.document) {
        // @run-at document-end means the body is normally there already; the listener is
        // for the case where the script manager injects earlier than advertised.
        if (window.document.body) {
            main(window);
        } else {
            window.document.addEventListener("DOMContentLoaded", () => main(window), { once: true });
        }
    }

    exports.main = main;

    return exports;

})({});
