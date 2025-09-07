import { Page } from 'rebrowser-playwright'

import { Workers } from '../Workers'

export class ABC extends Workers {
    // Defaults (ms)
    private static readonly DEFAULT_MIN_DELAY_MS = 1500
    private static readonly DEFAULT_MAX_DELAY_MS = 5000

    async doABC(page: Page) {
        this.bot.log(this.bot.isMobile, 'ABC', 'Trying to complete poll')

        try {
            let $ = await this.bot.browser.func.loadInCheerio(page)

            // Don't loop more than 15 in case unable to solve, would lock otherwise
            const maxIterations = 15
            let i
            for (i = 0; i < maxIterations && !$('span.rw_icon').length; i++) {
                // Random human-like pause before interacting
                await this.randomSleep()

                await page.waitForSelector('.wk_OptionClickClass', { state: 'visible', timeout: 10000 })

                const answers = $('.wk_OptionClickClass')
                // pick a random answer from the actual list
                const answerCount = answers.length || 0
                if (answerCount === 0) {
                    this.bot.log(this.bot.isMobile, 'ABC', 'No answers found on question — retrying', 'warn')
                    await this.bot.utils.wait(1000)
                    page = await this.bot.browser.utils.getLatestTab(page)
                    $ = await this.bot.browser.func.loadInCheerio(page)
                    continue
                }

                const idx = this.bot.utils.randomNumber(0, Math.max(0, answerCount - 1))
                const answer = answers[idx]?.attribs?.['id']

                if (!answer) {
                    this.bot.log(this.bot.isMobile, 'ABC', `Chosen answer had no id (idx=${idx}) — retrying`, 'warn')
                    await this.bot.utils.wait(1000)
                    page = await this.bot.browser.utils.getLatestTab(page)
                    $ = await this.bot.browser.func.loadInCheerio(page)
                    continue
                }

                await page.waitForSelector(`#${answer}`, { state: 'visible', timeout: 10000 })

                // tiny random pause before click to mimic human reaction
                await this.randomSleepShort()
                await page.click(`#${answer}`) // Click answer

                // random pause after clicking answer
                await this.randomSleep()

                await page.waitForSelector('div.wk_button', { state: 'visible', timeout: 10000 })
                // small random pause before clicking next
                await this.randomSleepShort()
                await page.click('div.wk_button') // Click next question button

                // wait for tab to update and load next question
                page = await this.bot.browser.utils.getLatestTab(page)
                $ = await this.bot.browser.func.loadInCheerio(page)

                // short pause after page load
                await this.randomSleep()
            }

            // final wait + close
            await this.bot.utils.wait(4000)
            await page.close()

            if (i === maxIterations) {
                this.bot.log(this.bot.isMobile, 'ABC', 'Failed to solve quiz, exceeded max iterations of 15', 'warn')
            } else {
                this.bot.log(this.bot.isMobile, 'ABC', 'Completed the ABC successfully')
            }

        } catch (error) {
            try { await page.close() } catch { /* ignore */ }
            this.bot.log(this.bot.isMobile, 'ABC', 'An error occurred:' + error, 'error')
        }
    }

    /**
     * Sleep for a random (longer) interval between actions.
     * Configurable via this.bot.config.abcMinDelayMs / abcMaxDelayMs (ms).
     */
    private async randomSleep() {
        const minMs = (this.bot.config as any)?.abcMinDelayMs ?? ABC.DEFAULT_MIN_DELAY_MS
        const maxMs = (this.bot.config as any)?.abcMaxDelayMs ?? ABC.DEFAULT_MAX_DELAY_MS
        const ms = this.bot.utils.randomNumber(minMs, maxMs)
        // Use 'log' which is accepted by your bot.log signature
        this.bot.log(this.bot.isMobile, 'ABC', `Sleeping for ${ms} ms`, 'log')
        await this.bot.utils.wait(ms)
    }

    /**
     * Smaller random pause used for micro-delays before clicks.
     */
    private async randomSleepShort() {
        // short = ~300ms .. 1200ms (configurable if desired)
        const minShort = (this.bot.config as any)?.abcMinShortDelayMs ?? 300
        const maxShort = (this.bot.config as any)?.abcMaxShortDelayMs ?? 1200
        const ms = this.bot.utils.randomNumber(minShort, maxShort)
        await this.bot.utils.wait(ms)
    }
}
