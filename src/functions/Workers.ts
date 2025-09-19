import { Page } from 'rebrowser-playwright'

import { DashboardData, MorePromotion, PromotionalItem, PunchCard } from '../interface/DashboardData'

import { MicrosoftRewardsBot } from '../index'

export class Workers {
    public bot: MicrosoftRewardsBot

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    /* =========================
       Utility helpers
       ========================= */

    /**
     * Return candidate selectors for an activity.
     * Tries:
     *  - [data-bi-id^="offerId"] .pointLink:not(.contentContainer .pointLink)
     *  - [data-bi-id*="namePart"] .pointLink...
     *  - any .pointLink whose ancestor data-bi-id looks like daily/gamification/global
     *  - .pointLink with nearby text/title matching activity.title
     */
    private async buildSelectorsForActivity(page: Page, activity: PromotionalItem | MorePromotion, punchCard?: PunchCard): Promise<string[]> {
        const candidates: string[] = []

        // Preferred pattern from logs and page: data-bi-id^="..."
        if (activity.offerId) {
            candidates.push(`[data-bi-id^="${activity.offerId}"] .pointLink:not(.contentContainer .pointLink)`)
            // also try with quoting escape if needed
            const esc = (activity.offerId || '').replace(/"/g, '\\"')
            candidates.push(`[data-bi-id^="${esc}"] .pointLink:not(.contentContainer .pointLink)`)
        }

        // If punch card, let the caller supply the selector (some caller functions do)
        if (punchCard) {
            // leave candidates empty here — caller already resolves selector via getPunchCardActivity
        }

        // If activity.name present, try using it (sometimes name is used as data-bi-id)
        if (activity.name) {
            const nameSafe = (activity.name || '').replace(/"/g, '\\"')
            candidates.push(`[data-bi-id^="${nameSafe}"] .pointLink:not(.contentContainer .pointLink)`)
            // substring match
            candidates.push(`[data-bi-id*="${nameSafe}"] .pointLink:not(.contentContainer .pointLink)`)
        }

        // Heuristic: use any .pointLink elements whose ancestor data-bi-id contains daily/gamification/global
        try {
            const heuristic = await page.evaluate(() => {
                const out: string[] = []
                const dailyRe = /dailyset|daily|global_daily|gamification_daily|dailyglobal|global_dailyset|global_daily/i
                const els = Array.from(document.querySelectorAll('.pointLink:not(.contentContainer .pointLink)')) as HTMLElement[]
                const seen = new Set<string>()
                for (const el of els) {
                    let anc: HTMLElement | null = el
                    let dataId = ''
                    while (anc && anc !== document.body) {
                        if (anc.hasAttribute && anc.hasAttribute('data-bi-id')) {
                            dataId = anc.getAttribute('data-bi-id') || ''
                            if (dailyRe.test(dataId)) break
                        }
                        anc = anc.parentElement
                    }
                    if (dataId && dailyRe.test(dataId)) {
                        const esc = dataId.replace(/"/g, '\\"')
                        const sel = `[data-bi-id="${esc}"] .pointLink:not(.contentContainer .pointLink)`
                        if (!seen.has(sel)) { seen.add(sel); out.push(sel) }
                    }
                }
                return out
            })

            for (const s of heuristic) {
                if (!candidates.includes(s)) candidates.push(s)
            }
        } catch {
            // ignore page-eval errors
        }

        // Fallback: generic .pointLink elements (limited)
        candidates.push('.pointLink:not(.contentContainer .pointLink)')
        candidates.push('.pointLink')

        // final unique list
        return Array.from(new Set(candidates))
    }

    /**
     * Hide fixed/overlay elements overlapping a selector (best-effort).
     * Marks hidden elements with data-qa-hidden-temp so we can restore them.
     * Returns number of elements hidden.
     *
     * Made protected so subclasses (UrlReward, Quiz, etc.) can call when needed.
     */
    protected async hideOverlappingOverlays(page: Page, selector: string): Promise<number> {
        try {
            return await page.evaluate((sel) => {
                const target = document.querySelector(sel) as HTMLElement | null;
                if (!target) return 0;
                const tBox = target.getBoundingClientRect();
                if (!tBox) return 0;
                const all = Array.from(document.querySelectorAll('body *')) as HTMLElement[];
                let hidden = 0;
                for (const el of all) {
                    try {
                        if (el === target) continue;
                        const style = window.getComputedStyle(el);
                        if (!style) continue;
                        if (style.display === 'none' || parseFloat(style.opacity || '1') === 0) continue;
                        const pos = style.position;
                        if (!(pos === 'fixed' || pos === 'absolute' || pos === 'sticky')) continue;
                        const r = el.getBoundingClientRect();
                        if (!r || r.width === 0 || r.height === 0) continue;
                        const overlap = !(r.right < tBox.left || r.left > tBox.right || r.bottom < tBox.top || r.top > tBox.bottom);
                        if (!overlap) continue;
                        // hide & mark
                        el.setAttribute('data-qa-hidden-temp', 'true');
                        (el as HTMLElement).style.setProperty('display', 'none', 'important');
                        hidden++;
                    } catch {
                        // ignore element-level errors
                    }
                }
                return hidden;
            }, selector);
        } catch {
            return 0;
        }
    }

    /**
     * Restore overlays hidden by hideOverlappingOverlays.
     * Returns number restored.
     *
     * Made protected so subclasses can trigger restoration as well.
     */
    protected async restoreHiddenOverlays(page: Page): Promise<number> {
        try {
            return await page.evaluate(() => {
                const hidden = Array.from(document.querySelectorAll('[data-qa-hidden-temp]')) as HTMLElement[];
                for (const el of hidden) {
                    try {
                        el.removeAttribute('data-qa-hidden-temp');
                        (el as HTMLElement).style.removeProperty('display');
                    } catch { /* ignore per-element */ }
                }
                return hidden.length;
            });
        } catch {
            return 0;
        }
    }

    /**
     * Robust click that attempts several strategies, detects popup/navigation,
     * and will try up to maxAttempts. This is intentionally conservative to avoid
     * wasting server time — default attempts = 3.
     */
    private async robustTryClickSelector(page: Page, selector: string, maxAttempts = 3, perAttemptTimeout = 10000): Promise<{ success: boolean, reason?: string, popup?: Page }> {
        // context for popup detection
        // @ts-ignore
        const context = page.context ? page.context() : null

        const tryOnce = async (sel: string, timeout: number): Promise<{ success: boolean, reason?: string, popup?: Page }> => {
            // wait short for element to appear
            try { await page.waitForSelector(sel, { state: 'attached', timeout: Math.min(2500, timeout) }) } catch { /* continue */ }

            // Scroll into view and check bounding/visibility
            try {
                const handle = await page.$(sel)
                if (!handle) return { success: false, reason: 'not-found' }

                try { await handle.scrollIntoViewIfNeeded?.({ timeout: 1500 }) } catch {
                    await page.evaluate((s) => {
                        const el = document.querySelector(s) as HTMLElement | null
                        if (el) el.scrollIntoView({ block: 'center', inline: 'center' })
                    }, sel)
                }

                const box = await handle.boundingBox()
                const style = await page.evaluate((s) => {
                    const el = document.querySelector(s) as HTMLElement | null
                    if (!el) return { display: 'none', visibility: 'hidden', opacity: '0', hidden: true }
                    const cs = window.getComputedStyle(el)
                    return { display: cs.display, visibility: cs.visibility, opacity: cs.opacity, hidden: el.hasAttribute('hidden') }
                }, sel)

                if (!box || box.width === 0 || box.height === 0) return { success: false, reason: 'zero-bounding-box' }
                if (style.hidden || style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) {
                    // try to hide overlays that might be covering this element
                    const hid = await this.hideOverlappingOverlays(page, sel)
                    if (hid === 0) {
                        return { success: false, reason: 'css-hidden' }
                    }
                    // we'll attempt to click after hiding overlays
                }
            } catch (err) {
                // continue to click attempts — sometimes computed style fails in weird pages
            }

            // prepare popup/navigation watchers (short windows)
            let popupPromise: Promise<Page | null> | null = null
            if (context) {
                popupPromise = context.waitForEvent('page', { timeout: 1500 }).catch(() => null)
            }
            const navPromise = page.waitForNavigation({ timeout: 1500 }).catch(() => null)

            // Try a sequence of click strategies:
            // 1) locator.click() (preferred)
            // 2) page.evaluate(el.click())
            // 3) bounding-box mouse click()
            // 4) locator.click({ force: true })

            let clickedOk = false
            try {
                const locator = page.locator(sel).first()
                await locator.scrollIntoViewIfNeeded?.({ timeout: 1500 }).catch(() => null)
                await locator.click({ timeout }).then(() => { clickedOk = true }).catch(() => null)

                if (!clickedOk) {
                    const evalClicked = await page.evaluate((s) => {
                        const el = document.querySelector(s) as HTMLElement | null
                        if (!el) return false
                        el.click()
                        return true
                    }, sel).catch(() => false)

                    if (evalClicked) {
                        clickedOk = true
                    } else {
                        // try bounding box mouse click
                        const h = await page.$(sel)
                        if (h) {
                            const box = await h.boundingBox()
                            if (box) {
                                await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => null)
                                clickedOk = true
                            }
                        }
                    }
                }
            } catch {
                // swallow
            }

            // If clickable still false, attempt forced locator click
            if (!clickedOk) {
                try {
                    const locator = page.locator(selector).first()
                    await locator.click({ timeout: perAttemptTimeout, force: true }).then(() => { clickedOk = true }).catch(() => null)
                } catch {
                    // final fail
                }
            }

            // restore overlays whether click succeeded or not (best-effort)
            try { await this.restoreHiddenOverlays(page) } catch { /* ignore */ }

            if (!clickedOk) return { success: false, reason: 'click-failed' }

            // short wait to detect popup/navigation
            const popup = popupPromise ? await popupPromise : null
            const nav = await navPromise

            if (popup) {
                try { await popup.waitForLoadState('domcontentloaded', { timeout: 2000 }).catch(() => null) } catch {}
                return { success: true, popup }
            }

            if (nav) {
                return { success: true }
            }

            // assume success if no navigation/popup and no error
            return { success: true }
        }

        // Attempt maxAttempts on this selector
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const result = await tryOnce(selector, perAttemptTimeout)
            if (result.success) return result
            // Only retry transient cases
            if (['click-failed', 'visibility-check-error', 'css-hidden'].includes(result.reason || '')) {
                await this.bot.utils.wait(this.bot.utils.randomNumber(300, 900))
                continue
            } else {
                return result
            }
        }

        return { success: false, reason: 'max-retries' }
    }

    /* =========================
       Public flows (DailySet / PunchCard / MorePromotions)
       ========================= */

    // Daily Set
    async doDailySet(page: Page, data: DashboardData) {
        const todayData = data.dailySetPromotions[this.bot.utils.getFormattedDate()]

        const activitiesUncompleted = todayData?.filter(x => !x.complete && x.pointProgressMax > 0) ?? []

        if (!activitiesUncompleted.length) {
            this.bot.log(this.bot.isMobile, 'DAILY-SET', 'All Daily Set items have already been completed')
            return
        }

        // Solve Activities
        this.bot.log(this.bot.isMobile, 'DAILY-SET', 'Started solving "Daily Set" items')

        await this.solveActivities(page, activitiesUncompleted)

        page = await this.bot.browser.utils.getLatestTab(page)

        // Always return to the homepage if not already
        await this.bot.browser.func.goHome(page)

        this.bot.log(this.bot.isMobile, 'DAILY-SET', 'All "Daily Set" items have been completed')
    }

    // Punch Card
    async doPunchCard(page: Page, data: DashboardData) {

        const punchCardsUncompleted = data.punchCards?.filter(x => x.parentPromotion && !x.parentPromotion.complete) ?? [] // Only return uncompleted punch cards

        if (!punchCardsUncompleted.length) {
            this.bot.log(this.bot.isMobile, 'PUNCH-CARD', 'All "Punch Cards" have already been completed')
            return
        }

        for (const punchCard of punchCardsUncompleted) {

            // Ensure parentPromotion exists before proceeding
            if (!punchCard.parentPromotion?.title) {
                this.bot.log(this.bot.isMobile, 'PUNCH-CARD', `Skipped punchcard "${punchCard.name}" | Reason: Parent promotion is missing!`, 'warn')
                continue
            }

            // Get latest page for each card
            page = await this.bot.browser.utils.getLatestTab(page)

            const activitiesUncompleted = punchCard.childPromotions.filter(x => !x.complete) // Only return uncompleted activities

            // Solve Activities
            this.bot.log(this.bot.isMobile, 'PUNCH-CARD', `Started solving "Punch Card" items for punchcard: "${punchCard.parentPromotion.title}"`)

            // Go to punch card index page in a new tab
            await page.goto(punchCard.parentPromotion.destinationUrl, { referer: this.bot.config.baseURL })

            // Wait for new page to load briefly; don't block too long
            await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => { })

            // Let solveActivities handle click robustness
            await this.solveActivities(page, activitiesUncompleted, punchCard)

            page = await this.bot.browser.utils.getLatestTab(page)

            const pages = page.context().pages()

            if (pages.length > 3) {
                await page.close()
            } else {
                await this.bot.browser.func.goHome(page)
            }

            this.bot.log(this.bot.isMobile, 'PUNCH-CARD', `All items for punchcard: "${punchCard.parentPromotion.title}" have been completed`)
        }

        this.bot.log(this.bot.isMobile, 'PUNCH-CARD', 'All "Punch Card" items have been completed')
    }

    // More Promotions
    async doMorePromotions(page: Page, data: DashboardData) {
        const morePromotions = data.morePromotions

        // Check if there is a promotional item
        if (data.promotionalItem) { // Convert and add the promotional item to the array
            morePromotions.push(data.promotionalItem as unknown as MorePromotion)
        }

        const activitiesUncompleted = morePromotions?.filter(x => !x.complete && x.pointProgressMax > 0 && x.exclusiveLockedFeatureStatus !== 'locked') ?? []

        if (!activitiesUncompleted.length) {
            this.bot.log(this.bot.isMobile, 'MORE-PROMOTIONS', 'All "More Promotion" items have already been completed')
            return
        }

        // Solve Activities
        this.bot.log(this.bot.isMobile, 'MORE-PROMOTIONS', 'Started solving "More Promotions" items')

        page = await this.bot.browser.utils.getLatestTab(page)

        await this.solveActivities(page, activitiesUncompleted)

        page = await this.bot.browser.utils.getLatestTab(page)

        // Always return to the homepage if not already
        await this.bot.browser.func.goHome(page)

        this.bot.log(this.bot.isMobile, 'MORE-PROMOTIONS', 'All "More Promotion" items have been completed')
    }

    /**
     * Solve all the different types of activities.
     * - Uses robust selector candidates and robust click logic.
     * - Limits attempts so we don't waste server time (3 tries per activity).
     */
    private async solveActivities(activityPage: Page, activities: PromotionalItem[] | MorePromotion[], punchCard?: PunchCard) {
        const activityInitial = activityPage.url() // Homepage for Daily/More and Index for promotions

        for (const activity of activities) {
            try {
                // Reselect the worker page
                activityPage = await this.bot.browser.utils.getLatestTab(activityPage)

                const pages = activityPage.context().pages()
                if (pages.length > 3) {
                    await activityPage.close()

                    activityPage = await this.bot.browser.utils.getLatestTab(activityPage)
                }

                await this.bot.utils.wait(1000)

                if (activityPage.url() !== activityInitial) {
                    await activityPage.goto(activityInitial).catch(() => { /* ignore navigation failure */ })
                }

                // Build selector candidates
                let selectors: string[] = []
                if (punchCard) {
                    // your existing helper: attempt to get a punch-card-specific selector first
                    try {
                        const derived = await this.bot.browser.func.getPunchCardActivity(activityPage, activity)
                        if (derived) selectors.push(derived)
                    } catch { /* ignore */ }
                }

                // Add generic candidates
                const built = await this.buildSelectorsForActivity(activityPage, activity as PromotionalItem, punchCard)
                selectors = selectors.concat(built)

                // Deduplicate
                selectors = Array.from(new Set(selectors)).filter(Boolean)

                // Wait briefly to let DOM settle
                await activityPage.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => { })
                await this.bot.utils.wait(1500)

                // Try clicking candidates (limit total candidate attempts to avoid long runs)
                let clickedResult: { success: boolean, reason?: string, popup?: Page } | null = null
                const maxCandidatesToTry = 5
                let candidateCount = 0

                for (const sel of selectors) {
                    if (candidateCount >= maxCandidatesToTry) break
                    candidateCount++

                    // Try robust click up to 3 attempts
                    const res = await this.robustTryClickSelector(activityPage, sel, 3, 10000)
                    if (res.success) {
                        clickedResult = res
                        break
                    } else {
                        // log the failure and continue
                        this.bot.log(this.bot.isMobile, 'ACTIVITY', `Could not click selector "${sel}" for "${activity.title}" | reason: ${res.reason}`, 'warn')
                    }
                }

                if (!clickedResult || !clickedResult.success) {
                    this.bot.log(this.bot.isMobile, 'ACTIVITY', `Skipped activity "${activity.title}" | Reason: Could not click any selectors (tried ${candidateCount})`, 'warn')
                    // Move on to next activity without blocking
                    await this.bot.utils.wait(500)
                    continue
                }

                // If click opened popup, switch to it
                if (clickedResult.popup) {
                    activityPage = clickedResult.popup
                    // give popup a moment
                    await this.bot.utils.wait(this.bot.utils.randomNumber(1000, 2500))
                } else {
                    // otherwise fetch the newest tab (sometimes navigation opens new tab)
                    activityPage = await this.bot.browser.utils.getLatestTab(activityPage)
                    await this.bot.utils.wait(1000)
                }

                // Process activity by type (preserve your existing logic)
                switch ((activity as PromotionalItem).promotionType) {
                    case 'quiz':
                        // pointProgressMax determines subtype
                        switch ((activity as PromotionalItem).pointProgressMax) {
                            case 10:
                                if ((activity as PromotionalItem).destinationUrl?.toLowerCase().includes('pollscenarioid')) {
                                    this.bot.log(this.bot.isMobile, 'ACTIVITY', `Found activity type: "Poll" title: "${activity.title}"`)
                                    await this.bot.activities.doPoll(activityPage)
                                } else {
                                    this.bot.log(this.bot.isMobile, 'ACTIVITY', `Found activity type: "ABC" title: "${activity.title}"`)
                                    await this.bot.activities.doABC(activityPage)
                                }
                                break
                            case 50:
                                this.bot.log(this.bot.isMobile, 'ACTIVITY', `Found activity type: "ThisOrThat" title: "${activity.title}"`)
                                await this.bot.activities.doThisOrThat(activityPage)
                                break
                            default:
                                this.bot.log(this.bot.isMobile, 'ACTIVITY', `Found activity type: "Quiz" title: "${activity.title}"`)
                                await this.bot.activities.doQuiz(activityPage)
                                break
                        }
                        break

                    case 'urlreward':
                        if ((activity as PromotionalItem).name?.toLowerCase().includes('exploreonbing') || (activity as PromotionalItem).destinationUrl?.includes('form=dsetqu')) {
                            this.bot.log(this.bot.isMobile, 'ACTIVITY', `Found activity type: "SearchOnBing" title: "${activity.title}"`)
                            await this.bot.activities.doSearchOnBing(activityPage, activity as PromotionalItem)
                        } else {
                            this.bot.log(this.bot.isMobile, 'ACTIVITY', `Found activity type: "UrlReward" title: "${activity.title}"`)
                            await this.bot.activities.doUrlReward(activityPage)
                        }
                        break

                    default:
                        this.bot.log(this.bot.isMobile, 'ACTIVITY', `Skipped activity "${activity.title}" | Reason: Unsupported type: "${(activity as PromotionalItem).promotionType}"!`, 'warn')
                        break
                }

                // Cooldown
                await this.bot.utils.wait(2000)
            } catch (error) {
                this.bot.log(this.bot.isMobile, 'ACTIVITY', 'An error occurred:' + error, 'error')
            }

        }
    }

}
