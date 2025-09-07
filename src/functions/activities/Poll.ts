import { Page } from 'rebrowser-playwright'

import { Workers } from '../Workers'


export class Poll extends Workers {

    async doPoll(page: Page) {
        this.bot.log(this.bot.isMobile, 'POLL', 'Trying to complete poll')

        try {
            const buttonId = `#btoption${Math.floor(this.bot.utils.randomNumber(0, 1))}`

            // Wait for poll to load with human-like timing
            await page.waitForSelector(buttonId, { state: 'visible', timeout: 10000 }).catch(() => { })

            // Human-like delay before interaction (1-3 seconds)
            await this.bot.utils.wait(this.bot.utils.randomNumber(1000, 3000))

            await page.click(buttonId)

            // Human-like delay after clicking (2-6 seconds)
            await this.bot.utils.wait(this.bot.utils.randomNumber(2000, 6000))
            await page.close()

            this.bot.log(this.bot.isMobile, 'POLL', 'Completed the poll successfully')
        } catch (error) {
            await page.close()
            this.bot.log(this.bot.isMobile, 'POLL', 'An error occurred:' + error, 'error')
        }
    }

}