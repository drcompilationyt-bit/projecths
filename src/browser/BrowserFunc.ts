import https from 'https'
import { BrowserContext, Page } from 'rebrowser-playwright'
import { CheerioAPI, load } from 'cheerio'
import { AxiosRequestConfig } from 'axios'

import { MicrosoftRewardsBot } from '../index'
import { saveSessionData } from '../util/Load'

import { Counters, DashboardData, MorePromotion, PromotionalItem } from './../interface/DashboardData'
import { QuizData } from './../interface/QuizData'
import { AppUserData } from '../interface/AppUserData'
import { EarnablePoints } from '../interface/Points'


export default class BrowserFunc {
    private bot: MicrosoftRewardsBot

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    /**
     * Helper: quiet randomized delay between 30-45 seconds to reduce race/timeout issues.
     */
    private async quietDelay() {
        const ms = 30000 + Math.floor(Math.random() * 15001) // 30,000 - 45,000 ms
        if (this.bot && this.bot.utils && typeof (this.bot.utils as any).wait === 'function') {
            await (this.bot.utils as any).wait(ms)
        } else {
            await new Promise(resolve => setTimeout(resolve, ms))
        }
    }

    /**
     * Navigate the provided page to rewards homepage
     * @param {Page} page Playwright page
     */
    async goHome(page: Page) {

        try {
            const dashboardURL = new URL(this.bot.config.baseURL)

            if (page.url() === dashboardURL.href) {
                return
            }

            await page.goto(this.bot.config.baseURL)

            // slight randomized delay after navigation
            await this.quietDelay()

            const maxIterations = 5 // Maximum iterations set to 5

            for (let iteration = 1; iteration <= maxIterations; iteration++) {
                await this.bot.utils.wait(3000)
                await this.bot.browser.utils.tryDismissAllMessages(page)

                // Check if account is suspended
                const isSuspended = await page.waitForSelector('#suspendedAccountHeader', { state: 'visible', timeout: 2000 }).then(() => true).catch(() => false)
                if (isSuspended) {
                    this.bot.log(this.bot.isMobile, 'GO-HOME', 'This account is suspended!', 'error')
                    throw new Error('Account has been suspended!')
                }

                try {
                    // If activities are found, exit the loop
                    await page.waitForSelector('#more-activities', { timeout: 1000 })
                    this.bot.log(this.bot.isMobile, 'GO-HOME', 'Visited homepage successfully')
                    break

                } catch (error) {
                    // Continue if element is not found
                }

                // Below runs if the homepage was unable to be visited
                const currentURL = new URL(page.url())

                if (currentURL.hostname !== dashboardURL.hostname) {
                    await this.bot.browser.utils.tryDismissAllMessages(page)

                    await this.bot.utils.wait(2000)
                    await page.goto(this.bot.config.baseURL)
                    // small delay after re-navigation
                    await this.quietDelay()
                } else {
                    this.bot.log(this.bot.isMobile, 'GO-HOME', 'Visited homepage successfully')
                    break
                }

                await this.bot.utils.wait(5000)
            }

        } catch (error) {
            // Log and rethrow a real Error so callers don't receive `undefined`
            this.bot.log(this.bot.isMobile, 'GO-HOME', 'An error occurred:' + error, 'error')
            throw new Error('GO-HOME error: ' + error)
        }
    }

    /**
     * Fetch user dashboard data
     * @returns {DashboardData} Object of user bing rewards dashboard data
     */
    async getDashboardData(): Promise<DashboardData> {
        const dashboardURL = new URL(this.bot.config.baseURL)
        const currentURL = new URL(this.bot.homePage.url())

        try {
            // Should never happen since tasks are opened in a new tab!
            if (currentURL.hostname !== dashboardURL.hostname) {
                this.bot.log(this.bot.isMobile, 'DASHBOARD-DATA', 'Provided page did not equal dashboard page, redirecting to dashboard page')
                await this.goHome(this.bot.homePage)
            }

            // Reload the page to get new data
            await this.bot.homePage.reload({ waitUntil: 'domcontentloaded' })

            // slight randomized delay before extracting dashboard data
            await this.quietDelay()

            const scriptContent = await this.bot.homePage.evaluate(() => {
                const scripts = Array.from(document.querySelectorAll('script'))
                const targetScript = scripts.find(script => script.innerText.includes('var dashboard'))

                return targetScript?.innerText ? targetScript.innerText : null
            })

            if (!scriptContent) {
                this.bot.log(this.bot.isMobile, 'GET-DASHBOARD-DATA', 'Dashboard data not found within script', 'error')
                throw new Error('Dashboard data not found within script')
            }

            // Extract the dashboard object from the script content
            const dashboardData = await this.bot.homePage.evaluate(scriptContent => {
                // Extract the dashboard object using regex
                const regex = /var dashboard = (\{.*?\});/s
                const match = regex.exec(scriptContent)

                if (match && match[1]) {
                    return JSON.parse(match[1])
                }

            }, scriptContent)

            if (!dashboardData) {
                this.bot.log(this.bot.isMobile, 'GET-DASHBOARD-DATA', 'Unable to parse dashboard script', 'error')
                throw new Error('Unable to parse dashboard script')
            }

            return dashboardData

        } catch (error) {
            this.bot.log(this.bot.isMobile, 'GET-DASHBOARD-DATA', `Error fetching dashboard data: ${error}`, 'error')
            throw new Error('GET-DASHBOARD-DATA error: ' + error)
        }

    }

    /**
     * Get search point counters
     * @returns {Counters} Object of search counter data
     */
    async getSearchPoints(): Promise<Counters> {
        const dashboardData = await this.getDashboardData() // Always fetch newest data

        return dashboardData.userStatus.counters
    }

    /**
     * Get total earnable points with web browser
     * @returns {number} Total earnable points
     */
    async getBrowserEarnablePoints(): Promise<EarnablePoints> {
        try {
            // small randomized delay to reduce rate/ordering issues
            await this.quietDelay()

            let desktopSearchPoints = 0
            let mobileSearchPoints = 0
            let dailySetPoints = 0
            let morePromotionsPoints = 0

            const data = await this.getDashboardData()

            // Desktop Search Points
            if (data.userStatus.counters.pcSearch?.length) {
                data.userStatus.counters.pcSearch.forEach(x => desktopSearchPoints += (x.pointProgressMax - x.pointProgress))
            }

            // Mobile Search Points
            if (data.userStatus.counters.mobileSearch?.length) {
                data.userStatus.counters.mobileSearch.forEach(x => mobileSearchPoints += (x.pointProgressMax - x.pointProgress))
            }

            // Daily Set
            data.dailySetPromotions[this.bot.utils.getFormattedDate()]?.forEach(x => dailySetPoints += (x.pointProgressMax - x.pointProgress))

            // More Promotions
            if (data.morePromotions?.length) {
                data.morePromotions.forEach(x => {
                    // Only count points from supported activities
                    if (['quiz', 'urlreward'].includes(x.promotionType) && x.exclusiveLockedFeatureStatus !== 'locked') {
                        morePromotionsPoints += (x.pointProgressMax - x.pointProgress)
                    }
                })
            }

            const totalEarnablePoints = desktopSearchPoints + mobileSearchPoints + dailySetPoints + morePromotionsPoints

            return {
                dailySetPoints,
                morePromotionsPoints,
                desktopSearchPoints,
                mobileSearchPoints,
                totalEarnablePoints
            }
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'GET-BROWSER-EARNABLE-POINTS', 'An error occurred:' + error, 'error')
            throw new Error('GET-BROWSER-EARNABLE-POINTS error: ' + error)
        }
    }

    /**
     * Get total earnable points with mobile app
     * @returns {object} Total earnable points for mobile app (readToEarn, checkIn, totalEarnablePoints, fetchError)
     */
    async getAppEarnablePoints(accessToken: string): Promise<{ readToEarn: number, checkIn: number, totalEarnablePoints: number, fetchError?: boolean }> {
        // This function now sets fetchError=true when network/parsing/certificate failures occur.
        try {
            // slight randomized delay before calling app API
            await this.quietDelay()

            const points = {
                readToEarn: 0,
                checkIn: 0,
                totalEarnablePoints: 0
            }

            const eligibleOffers = [
                'ENUS_readarticle3_30points',
                'Gamification_Sapphire_DailyCheckIn'
            ]

            const data = await this.getDashboardData()
            let geoLocale = data.userProfile.attributes.country
            geoLocale = (this.bot.config.searchSettings.useGeoLocaleQueries && geoLocale.length === 2) ? geoLocale.toLowerCase() : 'us'

            const userDataRequest: AxiosRequestConfig = {
                url: 'https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=613',
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'X-Rewards-Country': geoLocale,
                    'X-Rewards-Language': 'en'
                },
                // note: httpsAgent is added only on retry when a cert error is detected
            }

            // Try regular request first
            let userDataResponse: AppUserData | undefined
            try {
                userDataResponse = (await this.bot.axios.request(userDataRequest)).data as AppUserData
            } catch (err: any) {
                const msg = (err && (err.message || '')).toString().toLowerCase()
                const code = err && err.code

                const isCertError =
                    msg.includes('unable to verify the first certificate') ||
                    msg.includes('self signed certificate') ||
                    msg.includes('unable to get local issuer certificate') ||
                    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
                    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
                    code === 'ERR_TLS_CERT_ALTNAME_INVALID'

                if (isCertError) {
                    this.bot.log(this.bot.isMobile, 'GET-APP-EARNABLE-POINTS', 'Certificate verification failed — retrying once with relaxed SSL (insecure).', 'warn')

                    const insecureRequest: AxiosRequestConfig = {
                        ...userDataRequest,
                        httpsAgent: new https.Agent({ rejectUnauthorized: false })
                    }

                    try {
                        userDataResponse = (await this.bot.axios.request(insecureRequest)).data as AppUserData
                        this.bot.log(this.bot.isMobile, 'GET-APP-EARNABLE-POINTS', 'Retry with relaxed SSL succeeded.', 'log')
                    } catch (retryErr) {
                        this.bot.log(this.bot.isMobile, 'GET-APP-EARNABLE-POINTS', `Retry with relaxed SSL failed: ${retryErr}`, 'error')
                        // Return fetchError so caller knows this was a fetch failure
                        return { ...points, fetchError: true }
                    }
                } else {
                    // Not a certificate error — log and return fetchError
                    this.bot.log(this.bot.isMobile, 'GET-APP-EARNABLE-POINTS', `Failed fetching user data: ${err}`, 'error')
                    return { ...points, fetchError: true }
                }
            }

            if (!userDataResponse || !userDataResponse.response) {
                this.bot.log(this.bot.isMobile, 'GET-APP-EARNABLE-POINTS', 'User data response missing or malformed', 'warn')
                return { ...points, fetchError: true }
            }

            const userData = userDataResponse.response
            const eligibleActivities = userData.promotions.filter((x: any) => eligibleOffers.includes(x.attributes.offerid ?? ''))

            for (const item of eligibleActivities) {
                if (item.attributes.type === 'msnreadearn') {
                    points.readToEarn = parseInt(item.attributes.pointmax ?? '') - parseInt(item.attributes.pointprogress ?? '')
                    break
                } else if (item.attributes.type === 'checkin') {
                    const checkInDay = parseInt(item.attributes.progress ?? '') % 7

                    if (checkInDay < 6 && (new Date()).getDate() != (new Date(item.attributes.last_updated ?? '')).getDate()) {
                        points.checkIn = parseInt(item.attributes['day_' + (checkInDay + 1) + '_points'] ?? '')
                    }
                    break
                }
            }

            points.totalEarnablePoints = points.readToEarn + points.checkIn

            return { ...points, fetchError: false }
        } catch (error) {
            // Log and return fetchError so caller can detect this case
            this.bot.log(this.bot.isMobile, 'GET-APP-EARNABLE-POINTS', 'An error occurred: ' + error, 'error')
            return { readToEarn: 0, checkIn: 0, totalEarnablePoints: 0, fetchError: true }
        }
    }

    /**
     * Get current point amount
     * @returns {number} Current total point amount
     */
    async getCurrentPoints(): Promise<number> {
        try {
            const data = await this.getDashboardData()

            return data.userStatus.availablePoints
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'GET-CURRENT-POINTS', 'An error occurred:' + error, 'error')
            throw new Error('GET-CURRENT-POINTS error: ' + error)
        }
    }

    /**
     * Parse quiz data from provided page
     * @param {Page} page Playwright page
     * @returns {QuizData} Quiz data object
     */
    async getQuizData(page: Page): Promise<QuizData> {
        try {
            const html = await page.content()
            const $ = load(html)

            // slight randomized delay after loading quiz page content
            await this.quietDelay()

            const scriptContent = $('script').filter((index, element) => {
                return $(element).text().includes('_w.rewardsQuizRenderInfo')
            }).text()

            if (scriptContent) {
                const regex = /_w\.rewardsQuizRenderInfo\s*=\s*({.*?});/s
                const match = regex.exec(scriptContent)

                if (match && match[1]) {
                    const quizData = JSON.parse(match[1])
                    return quizData
                } else {
                    this.bot.log(this.bot.isMobile, 'GET-QUIZ-DATA', 'Quiz data not found within script', 'error')
                    throw new Error('Quiz data not found within script')
                }
            } else {
                this.bot.log(this.bot.isMobile, 'GET-QUIZ-DATA', 'Script containing quiz data not found', 'error')
                throw new Error('Script containing quiz data not found')
            }

        } catch (error) {
            this.bot.log(this.bot.isMobile, 'GET-QUIZ-DATA', 'An error occurred:' + error, 'error')
            throw new Error('GET-QUIZ-DATA error: ' + error)
        }

    }

    async waitForQuizRefresh(page: Page): Promise<boolean> {
        try {
            await page.waitForSelector('span.rqMCredits', { state: 'visible', timeout: 10000 })
            await this.bot.utils.wait(2000)

            return true
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'QUIZ-REFRESH', 'An error occurred:' + error, 'error')
            return false
        }
    }

    async checkQuizCompleted(page: Page): Promise<boolean> {
        try {
            await page.waitForSelector('#quizCompleteContainer', { state: 'visible', timeout: 2000 })
            await this.bot.utils.wait(2000)

            return true
        } catch (error) {
            return false
        }
    }

    async loadInCheerio(page: Page): Promise<CheerioAPI> {
        const html = await page.content()
        const $ = load(html)

        return $
    }

    async getPunchCardActivity(page: Page, activity: PromotionalItem | MorePromotion): Promise<string> {
        let selector = ''
        try {
            const html = await page.content()
            const $ = load(html)

            // slight randomized delay after loading punch-card page content
            await this.quietDelay()

            const element = $('.offer-cta').toArray().find(x => x.attribs.href?.includes(activity.offerId))
            if (element) {
                selector = `a[href*="${element.attribs.href}"]`
            }
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'GET-PUNCHCARD-ACTIVITY', 'An error occurred:' + error, 'error')
        }

        return selector
    }

    async closeBrowser(browser: BrowserContext, email: string) {
        try {
            // slight randomized delay before saving session & closing
            await this.quietDelay()

            // Save cookies
            await saveSessionData(this.bot.config.sessionPath, browser, email, this.bot.isMobile)

            await this.bot.utils.wait(2000)

            // Close browser
            await browser.close()
            this.bot.log(this.bot.isMobile, 'CLOSE-BROWSER', 'Browser closed cleanly!')
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'CLOSE-BROWSER', 'An error occurred:' + error, 'error')
            throw new Error('CLOSE-BROWSER error: ' + error)
        }
    }
}
