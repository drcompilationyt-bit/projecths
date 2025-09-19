import { Page } from 'rebrowser-playwright'
import { Workers } from '../Workers'

export class Quiz extends Workers {
    /**
     * Helper: hide any fixed/overlay elements that visually cover `sel` (temporary).
     * Returns number of elements hidden.
     */
    private async hideBlockingOverlays(page: Page, sel: string) : Promise<number> {
        try {
            return await page.evaluate((selector) => {
                const target = document.querySelector(selector) as HTMLElement | null;
                if (!target) return 0;
                const tBox = target.getBoundingClientRect();
                const docElems = Array.from(document.querySelectorAll('body *')) as HTMLElement[];
                let hiddenCount = 0;
                for (const el of docElems) {
                    try {
                        const style = window.getComputedStyle(el);
                        if (!style || style.display === 'none' || parseFloat(style.opacity || '1') === 0) continue;
                        const pos = style.position;
                        if (pos !== 'fixed' && pos !== 'absolute' && pos !== 'sticky') continue;
                        const z = parseInt(style.zIndex || '0') || 0;
                        // ignore the target itself and small elements
                        if (el === target) continue;
                        const r = el.getBoundingClientRect();
                        if (r.width === 0 || r.height === 0) continue;
                        // simple overlap test
                        const overlap = !(r.right < tBox.left || r.left > tBox.right || r.bottom < tBox.top || r.top > tBox.bottom);
                        if (overlap && z >= 0) {
                            // hide it (set an attribute marker and force display none)
                            el.setAttribute('data-qa-hidden-temp', 'true');
                            (el as HTMLElement).style.setProperty('display', 'none', 'important');
                            hiddenCount++;
                        }
                    } catch { /* ignored for safety */ }
                }
                return hiddenCount;
            }, sel);
        } catch (e) {
            return 0;
        }
    }

    /**
     * Find candidate elements for daily activities if the provided selector fails.
     * Strategy:
     *  - look for .pointLink (but not nested .contentContainer .pointLink)
     *  - prefer those whose ancestor has a data-bi-id containing keywords like 'DailySet'/'Daily'/'Global'
     *  - return array of descriptors we can try clicking (CSS selector strings).
     */
    private async findDailyCandidates(page: Page): Promise<string[]> {
        try {
            const candidates: string[] = await page.evaluate(() => {
                const out: string[] = [];
                const els = Array.from(document.querySelectorAll('.pointLink:not(.contentContainer .pointLink)')) as HTMLElement[];
                const seen = new Set<string>();
                const dailyRegex = /dailyset|daily|global_daily|gamification_daily|dailyglobaloffer/i;

                for (const el of els) {
                    // walk up to find ancestor with data-bi-id if any
                    let anc: HTMLElement | null = el;
                    let dataId: string | null = null;
                    while (anc && anc !== document.body) {
                        if ((anc as HTMLElement).hasAttribute && (anc as HTMLElement).hasAttribute('data-bi-id')) {
                            dataId = (anc as HTMLElement).getAttribute('data-bi-id');
                            break;
                        }
                        anc = anc.parentElement;
                    }

                    // candidate prioritization:
                    if (dataId && dailyRegex.test(dataId)) {
                        // produce a specific selector that targets this data-bi-id's pointLink
                        const esc = dataId.replace(/"/g, '\\"');
                        const sel = `[data-bi-id="${esc}"] .pointLink:not(.contentContainer .pointLink)`;
                        if (!seen.has(sel)) { out.push(sel); seen.add(sel); }
                    } else {
                        try {
                            const parent = el.closest('[data-section]') || el.parentElement || document.body;
                            const idx = Array.from(parent.querySelectorAll('.pointLink')).indexOf(el);
                            const tag = parent && (parent as HTMLElement).tagName ? (parent as HTMLElement).tagName.toLowerCase() : 'div';
                            const sel = `${tag} .pointLink:not(.contentContainer .pointLink):nth-of-type(${idx + 1})`;
                            if (!seen.has(sel)) { out.push(sel); seen.add(sel); }
                        } catch {
                            // skip
                        }
                    }
                }

                // Also try any element whose data-bi-id contains 'Child' and 'Daily' etc.
                const extras = Array.from(document.querySelectorAll('[data-bi-id]')) as HTMLElement[];
                for (const e of extras) {
                    const id = e.getAttribute('data-bi-id') || '';
                    if (dailyRegex.test(id) && id.toLowerCase().includes('child')) {
                        const esc = id.replace(/"/g, '\\"');
                        const sel = `[data-bi-id="${esc}"] .pointLink:not(.contentContainer .pointLink)`;
                        if (!seen.has(sel)) { out.push(sel); seen.add(sel); }
                    }
                }

                return out;
            });

            return candidates;
        } catch (err) {
            return [];
        }
    }

    /**
     * Click helper that retries up to maxAttempts.
     * - Keeps original behavior (scrolling, visibility checks, popup/nav detection)
     * - If an explicit selector fails, tries heuristics that scan the page for daily items
     * - Temporarily hides blocking overlays that visually cover the element
     * - Uses evaluate click fallback and 'force' if absolutely necessary
     * Returns: { success: boolean, reason?: string, popup?: Page }
     */
    private async clickWithRetries(page: Page, selector: string, maxAttempts = 3, perAttemptTimeout = 10000) : Promise<{ success: boolean, reason?: string, popup?: Page }> {
        // Small helper to test visibility and bounding rect
        const isVisibleAndClickable = async (sel: string) => {
            try {
                const handle = await page.$(sel);
                if (!handle) return { ok: false, reason: 'not-found' };
                try { await handle.scrollIntoViewIfNeeded?.({ timeout: 2000 }); } catch {
                    await page.evaluate((s) => {
                        const el = document.querySelector(s) as HTMLElement | null;
                        if (el) el.scrollIntoView({ block: 'center', inline: 'center' });
                    }, sel);
                }

                const box = await handle.boundingBox();
                const visible = await page.evaluate((s) => {
                    const el = document.querySelector(s) as HTMLElement | null;
                    if (!el) return { display: 'none', visibility: 'hidden', opacity: '0', hidden: true };
                    const style = window.getComputedStyle(el);
                    return { display: style.display, visibility: style.visibility, opacity: style.opacity, hidden: el.hasAttribute('hidden') };
                }, sel);

                if (!box || box.width === 0 || box.height === 0) return { ok: false, reason: 'zero-bounding-box' };
                if (visible.hidden || visible.display === 'none' || visible.visibility === 'hidden' || parseFloat(visible.opacity || '1') === 0) {
                    return { ok: false, reason: 'css-hidden' };
                }
                return { ok: true };
            } catch (err) {
                return { ok: false, reason: 'visibility-check-error' };
            }
        };

        // get context for popup detection
        // @ts-ignore
        const context = page.context ? page.context() : null;

        // internal attempt to click a selector once (with overlay-hiding & force fallback)
        const tryClickOnce = async (sel: string, timeout: number) : Promise<{ success: boolean, reason?: string, popup?: Page }> => {
            // wait short for selector presence
            try {
                await page.waitForSelector(sel, { state: 'attached', timeout: Math.min(3000, timeout) });
            } catch {
                // not attached quickly; continue, caller will decide
            }

            const visibility = await isVisibleAndClickable(sel);
            if (!visibility.ok) {
                this.bot.log(this.bot.isMobile, 'QUIZ', `clickWithRetries: selector not visible/clickable (${visibility.reason}): ${sel}`, 'warn');
                if (visibility.reason === 'css-hidden') {
                    // attempt to hide blocking overlays then re-evaluate
                    const hidden = await this.hideBlockingOverlays(page, sel);
                    if (hidden > 0) {
                        this.bot.log(this.bot.isMobile, 'QUIZ', `clickWithRetries: hid ${hidden} overlay(s) covering ${sel}`);
                    }
                } else if (['not-found','zero-bounding-box'].includes(visibility.reason || '')) {
                    return { success: false, reason: visibility.reason };
                }
            }

            // prepare popup & navigation listeners
            let popupPromise: Promise<Page | null> | null = null;
            if (context) {
                popupPromise = context.waitForEvent('page', { timeout: 1000 }).catch(() => null);
            }
            const navigationPromise = page.waitForNavigation({ timeout: 1000 }).catch(() => null);

            // try normal click
            try {
                // prefer locator.click where possible
                const locator = page.locator(sel).first();
                await locator.scrollIntoViewIfNeeded?.({ timeout: 2000 }).catch(() => null);
                await locator.click({ timeout }).catch(async (err) => {
                    // fallback to evaluate click on the element
                    this.bot.log(this.bot.isMobile, 'QUIZ', `clickWithRetries: locator.click failed for ${sel} - trying evaluate click (${err})`, 'warn');
                    const clicked = await page.evaluate((s) => {
                        const el = document.querySelector(s) as HTMLElement | null;
                        if (!el) return false;
                        el.click();
                        return true;
                    }, sel).catch(() => false);
                    if (!clicked) {
                        // final fallback: force click via bounding box
                        const h = await page.$(sel);
                        if (h) {
                            const box = await h.boundingBox();
                            if (box) {
                                // mouse.click does not accept a timeout option
                                await page.mouse.click(box.x + box.width/2, box.y + box.height/2);
                            } else {
                                throw new Error('no-bounding-box-for-force-click');
                            }
                        } else {
                            throw new Error('element-missing-for-force-click');
                        }
                    }
                });
            } catch (err) {
                // last resort: try locator.click with force true (dangerous but sometimes needed)
                this.bot.log(this.bot.isMobile, 'QUIZ', `clickWithRetries: page click fallback for ${sel}: ${err}`, 'warn');
                try {
                    const locator = page.locator(sel).first();
                    await locator.click({ timeout, force: true }).catch(() => { throw new Error('force-click-failed'); });
                } catch (err2) {
                    this.bot.log(this.bot.isMobile, 'QUIZ', `clickWithRetries: all click attempts failed for ${sel}: ${err2}`, 'error');
                    return { success: false, reason: 'click-failed' };
                }
            }

            // detect popup/navigation
            const popup = popupPromise ? await popupPromise : null;
            const nav = await navigationPromise;

            if (popup) {
                try { await popup.waitForLoadState('domcontentloaded', { timeout: 2000 }).catch(() => null); } catch {}
                this.bot.log(this.bot.isMobile, 'QUIZ', `clickWithRetries: click opened popup for ${sel}`);
                return { success: true, popup };
            }

            if (nav) {
                this.bot.log(this.bot.isMobile, 'QUIZ', `clickWithRetries: click caused navigation for ${sel}`);
                return { success: true };
            }

            // assume success
            this.bot.log(this.bot.isMobile, 'QUIZ', `clickWithRetries: click success for ${sel}`);
            return { success: true };
        };

        // 1) First, try the selector the caller provided (preserve original behavior)
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const res = await tryClickOnce(selector, perAttemptTimeout);
            if (res.success) return res;
            // quick retry philosophy: if it's a transient visibility issue, wait small then retry
            if (res.reason === 'css-hidden' || res.reason === 'visibility-check-error') {
                await this.bot.utils.wait(this.bot.utils.randomNumber(300, 800));
                continue;
            } else {
                // not found or hard fail: break to try DOM heuristics
                break;
            }
        }

        // 2) If that fails, attempt DOM heuristics to find the current daily item(s)
        const candidates = await this.findDailyCandidates(page);
        if (!candidates || candidates.length === 0) {
            this.bot.log(this.bot.isMobile, 'QUIZ', `clickWithRetries: no fallback candidates found for ${selector}`, 'warn');
            return { success: false, reason: 'no-candidates' };
        }

        // Try each candidate up to maxAttempts each but keep global attempt cap to avoid wasting time
        for (const candidate of candidates) {
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                const res = await tryClickOnce(candidate, perAttemptTimeout);
                if (res.success) return res;
                // if reason is not transient, stop trying this candidate
                if (!['css-hidden','visibility-check-error','click-failed'].includes(res.reason || '')) break;
                await this.bot.utils.wait(this.bot.utils.randomNumber(300, 800));
            }
        }

        // exhausted attempts and candidates
        this.bot.log(this.bot.isMobile, 'QUIZ', `clickWithRetries: exhausted attempts and candidates for ${selector}`, 'error');
        return { success: false, reason: 'max-retries' };
    }

    async doQuiz(page: Page) {
        this.bot.log(this.bot.isMobile, 'QUIZ', 'Trying to complete quiz');

        try {
            // Check if the quiz has been started or not
            const quizNotStarted = await page.waitForSelector('#rqStartQuiz', { state: 'visible', timeout: 2000 }).then(() => true).catch(() => false);
            if (quizNotStarted) {
                // Human-like delay before starting quiz (1-2 seconds)
                await this.bot.utils.wait(this.bot.utils.randomNumber(1000, 2000));

                // Try up to 3 times to click start and don't waste server time
                const startClick = await this.clickWithRetries(page, '#rqStartQuiz', 3, 10000);
                if (!startClick.success) {
                    this.bot.log(this.bot.isMobile, 'QUIZ', `Could not click #rqStartQuiz after retries: ${startClick.reason}`, 'error');
                    try { await page.close(); } catch {}
                    return;
                }
                if (startClick.popup) {
                    // If it opened a popup page, continue on that page object
                    page = startClick.popup;
                }
            } else {
                this.bot.log(this.bot.isMobile, 'QUIZ', 'Quiz has already been started, trying to finish it');
            }

            // Human-like delay after starting/continuing quiz (2-4 seconds)
            await this.bot.utils.wait(this.bot.utils.randomNumber(2000, 4000));

            let quizData = await this.bot.browser.func.getQuizData(page);
            if (!quizData || typeof quizData.maxQuestions !== 'number' || typeof quizData.CorrectlyAnsweredQuestionCount !== 'number') {
                this.bot.log(this.bot.isMobile, 'QUIZ', 'Invalid initial quizData returned, aborting', 'error');
                try { await page.close(); } catch {}
                return;
            }

            // Compute questionsRemaining dynamically inside loop
            let questionsRemaining = quizData.maxQuestions - quizData.CorrectlyAnsweredQuestionCount;

            for (let question = 0; question < questionsRemaining; question++) {

                // Refresh quizData each iteration (defensive)
                quizData = await this.bot.browser.func.getQuizData(page);
                if (!quizData || typeof quizData.numberOfOptions !== 'number') {
                    this.bot.log(this.bot.isMobile, 'QUIZ', 'Quiz data invalid while looping, breaking out', 'warn');
                    break;
                }

                // Multi-select / 8 option case (multiple correct answers)
                if (quizData.numberOfOptions === 8) {
                    const answers: string[] = [];

                    for (let i = 0; i < quizData.numberOfOptions; i++) {
                        const selector = `#rqAnswerOption${i}`;
                        try {
                            const handle = await page.waitForSelector(selector, { state: 'visible', timeout: 10000 }).catch(() => null);
                            if (!handle) continue;
                            const answerAttribute = await handle.evaluate((el: HTMLElement) => el.getAttribute('iscorrectoption'));
                            if (answerAttribute && answerAttribute.toLowerCase() === 'true') {
                                answers.push(selector);
                            }
                        } catch (err) {
                            this.bot.log(this.bot.isMobile, 'QUIZ', `Error reading iscorrectoption for ${selector}: ${err}`, 'warn');
                        }
                    }

                    for (const answerSelector of answers) {
                        // Human-like delay before clicking each answer (0.5-1.5 seconds)
                        await this.bot.utils.wait(this.bot.utils.randomNumber(500, 1500));

                        const clickRes = await this.clickWithRetries(page, answerSelector, 3, 12000);
                        if (!clickRes.success) {
                            this.bot.log(this.bot.isMobile, 'QUIZ', `Failed to click multi-answer ${answerSelector}: ${clickRes.reason}`, 'warn');
                            // move to next answer / next activity — do not block entire run
                            continue;
                        }
                        if (clickRes.popup) page = clickRes.popup;

                        const refreshSuccess = await this.bot.browser.func.waitForQuizRefresh(page);
                        if (!refreshSuccess) {
                            try { await page.close(); } catch {}
                            this.bot.log(this.bot.isMobile, 'QUIZ', 'An error occurred, refresh was unsuccessful', 'error');
                            return;
                        }

                        // Human-like delay after clicking (1-3 seconds)
                        await this.bot.utils.wait(this.bot.utils.randomNumber(1000, 3000));
                    }

                } else if ([2, 3, 4].includes(quizData.numberOfOptions)) {
                    // Human-like delay before processing question (1-2 seconds)
                    await this.bot.utils.wait(this.bot.utils.randomNumber(1000, 2000));

                    quizData = await this.bot.browser.func.getQuizData(page);
                    const correctOption = quizData.correctAnswer;

                    for (let i = 0; i < quizData.numberOfOptions; i++) {
                        const selector = `#rqAnswerOption${i}`;
                        try {
                            const handle = await page.waitForSelector(selector, { state: 'visible', timeout: 10000 }).catch(() => null);
                            if (!handle) continue;
                            const dataOption = await handle.evaluate((el: HTMLElement) => el.getAttribute('data-option'));
                            if (dataOption === correctOption) {
                                // Human-like delay before clicking correct answer (0.8-2 seconds)
                                await this.bot.utils.wait(this.bot.utils.randomNumber(800, 2000));

                                const clickRes = await this.clickWithRetries(page, selector, 3, 12000);
                                if (!clickRes.success) {
                                    this.bot.log(this.bot.isMobile, 'QUIZ', `Failed to click correct option ${selector}: ${clickRes.reason}`, 'warn');
                                    // try one more time, but if still fails, move on
                                    const retry = await this.clickWithRetries(page, selector, 1, 8000);
                                    if (!retry.success) {
                                        this.bot.log(this.bot.isMobile, 'QUIZ', `Retry also failed for ${selector}, skipping.`, 'warn');
                                        break;
                                    } else {
                                        if (retry.popup) page = retry.popup;
                                    }
                                } else {
                                    if (clickRes.popup) page = clickRes.popup;
                                }

                                const refreshSuccess = await this.bot.browser.func.waitForQuizRefresh(page);
                                if (!refreshSuccess) {
                                    try { await page.close(); } catch {}
                                    this.bot.log(this.bot.isMobile, 'QUIZ', 'An error occurred, refresh was unsuccessful', 'error');
                                    return;
                                }

                                // Human-like delay after clicking (1.5-3.5 seconds)
                                await this.bot.utils.wait(this.bot.utils.randomNumber(1500, 3500));
                                break;
                            }
                        } catch (err) {
                            this.bot.log(this.bot.isMobile, 'QUIZ', `Error while processing ${selector}: ${err}`, 'warn');
                        }
                    }

                    // Human-like delay between questions (2-4 seconds)
                    await this.bot.utils.wait(this.bot.utils.randomNumber(2000, 4000));
                } else {
                    // unsupported numberOfOptions
                    this.bot.log(this.bot.isMobile, 'QUIZ', `Unsupported numberOfOptions: ${quizData.numberOfOptions}`, 'warn');
                    break;
                }

                // recalc remaining questions defensively
                const refreshed = await this.bot.browser.func.getQuizData(page).catch(() => null);
                if (refreshed && typeof refreshed.CorrectlyAnsweredQuestionCount === 'number') {
                    questionsRemaining = refreshed.maxQuestions - refreshed.CorrectlyAnsweredQuestionCount;
                    if (questionsRemaining <= 0) break;
                }
            }

            // Done with quiz - human-like delay before closing (2-5 seconds)
            await this.bot.utils.wait(this.bot.utils.randomNumber(2000, 5000));
            try { await page.close(); } catch {}

            this.bot.log(this.bot.isMobile, 'QUIZ', 'Completed the quiz successfully');
        } catch (error) {
            try { await page.close(); } catch {}
            this.bot.log(this.bot.isMobile, 'QUIZ', 'An error occurred:' + error, 'error');
        }
    }
}
