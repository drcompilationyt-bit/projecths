import { Page } from 'rebrowser-playwright'
import * as fs from 'fs'
import path from 'path'

import { Workers } from '../Workers'

import { MorePromotion, PromotionalItem } from '../../interface/DashboardData'


export class SearchOnBing extends Workers {

    async doSearchOnBing(page: Page, activity: MorePromotion | PromotionalItem) {
        this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING', 'Trying to complete SearchOnBing')

        try {
            // Human-like delay before starting (2-5 seconds)
            await this.bot.utils.wait(this.bot.utils.randomNumber(2000, 5000))

            await this.bot.browser.utils.tryDismissAllMessages(page)

            const query = await this.getSearchQuery(activity.title)

            const searchBar = '#sb_form_q'
            await page.waitForSelector(searchBar, { state: 'visible', timeout: 10000 })

            // Human-like delay before clicking search bar (0.5-1.5 seconds)
            await this.bot.utils.wait(this.bot.utils.randomNumber(500, 1500))

            await page.click(searchBar)

            // Human-like delay after clicking (0.3-1 second)
            await this.bot.utils.wait(this.bot.utils.randomNumber(300, 1000))

            await page.keyboard.type(query)

            // Human-like delay before pressing enter (0.5-2 seconds)
            await this.bot.utils.wait(this.bot.utils.randomNumber(500, 2000))

            await page.keyboard.press('Enter')

            // Human-like delay after search (3-7 seconds)
            await this.bot.utils.wait(this.bot.utils.randomNumber(3000, 7000))

            // Human-like delay before closing (1-3 seconds)
            await this.bot.utils.wait(this.bot.utils.randomNumber(1000, 3000))

            await page.close()

            this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING', 'Completed the SearchOnBing successfully')
        } catch (error) {
            // Human-like delay before closing on error (1-2 seconds)
            await this.bot.utils.wait(this.bot.utils.randomNumber(1000, 2000))

            await page.close()
            this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING', 'An error occurred:' + error, 'error')
        }
    }

    private async getSearchQuery(title: string): Promise<string> {
        // Human-like delay before fetching query (0.5-1.5 seconds)
        await this.bot.utils.wait(this.bot.utils.randomNumber(500, 1500))

        interface Queries {
            title: string;
            queries: string[]
        }

        let queries: Queries[] = []

        try {
            if (this.bot.config.searchOnBingLocalQueries) {
                const data = fs.readFileSync(path.join(__dirname, '../queries.json'), 'utf8')
                queries = JSON.parse(data)
            } else {
                // Fetch from the repo directly so the user doesn't need to redownload the script for the new activities
                // Human-like delay before API request (0.3-1 second)
                await this.bot.utils.wait(this.bot.utils.randomNumber(300, 1000))

                const response = await this.bot.axios.request({
                    method: 'GET',
                    url: 'https://raw.githubusercontent.com/TheNetsky/Microsoft-Rewards-Script/refs/heads/main/src/functions/queries.json'
                })
                queries = response.data
            }

            const answers = queries.find(x => this.normalizeString(x.title) === this.normalizeString(title))
            const answer = answers ? this.bot.utils.shuffleArray(answers?.queries)[0] as string : title

            this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING-QUERY', `Fetched answer: ${answer} | question: ${title}`)
            return answer

        } catch (error) {
            this.bot.log(this.bot.isMobile, 'SEARCH-ON-BING-QUERY', 'An error occurred:' + error, 'error')
            return title
        }
    }

    private normalizeString(string: string): string {
        return string.normalize('NFD').trim().toLowerCase().replace(/[^\x20-\x7E]/g, '').replace(/[?!]/g, '')
    }
}