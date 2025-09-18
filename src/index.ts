import cluster from 'cluster'
import { Page } from 'rebrowser-playwright'

import Browser from './browser/Browser'
import BrowserFunc from './browser/BrowserFunc'
import BrowserUtil from './browser/BrowserUtil'

import { log } from './util/Logger'
import Util from './util/Utils'
import { loadAccounts, loadConfig, saveSessionData } from './util/Load'

import { Login } from './functions/Login'
import { Workers } from './functions/Workers'
import Activities from './functions/Activities'

import { Account } from './interface/Account'
import Axios from './util/Axios'

// --- Small helpers used by this module ---
function shuffleArray<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        // Assert non-undefined because we’re within valid indices
        const tmp = arr[i] as T
        arr[i] = arr[j] as T
        arr[j] = tmp
    }
    return arr
}

function randomInt(min: number, max: number) {
    if (min > max) [min, max] = [max, min]
    return Math.floor(Math.random() * (max - min + 1)) + min
}

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
}
// --- end helpers ---

// Main bot class
export class MicrosoftRewardsBot {
    public log: typeof log
    public config
    public utils: Util
    public activities: Activities = new Activities(this)
    public browser: {
        func: BrowserFunc,
        utils: BrowserUtil
    }
    public isMobile: boolean
    public homePage!: Page

    private pointsCanCollect: number = 0
    private pointsInitial: number = 0

    private activeWorkers: number
    private mobileRetryAttempts: number
    private browserFactory: Browser = new Browser(this)
    private accounts: Account[]
    private workers: Workers
    private login = new Login(this)
    private accessToken: string = ''

    //@ts-expect-error Will be initialized later
    public axios: Axios

    constructor(isMobile: boolean) {
        this.isMobile = isMobile
        this.log = log

        this.accounts = []
        this.utils = new Util()
        this.workers = new Workers(this)
        this.browser = {
            func: new BrowserFunc(this),
            utils: new BrowserUtil(this)
        }
        this.config = loadConfig()
        this.activeWorkers = typeof (this.config as any)?.clusters === 'number' ? (this.config as any).clusters : 0
        this.mobileRetryAttempts = 0
    }

    async initialize() {
        this.accounts = loadAccounts()
        // attach accounts to config so other parts can use them if needed
        ;(this.config as any).accounts = this.accounts
    }

    async run() {
        log('main', 'MAIN', `Bot started with clusters=${(this.config as any)?.clusters ?? 'unset'}`)

        // Optionally shuffle accounts globally (configurable)
        const shouldShuffle = (this.config as any)?.shuffleAccounts ?? false
        if (shouldShuffle) {
            shuffleArray(this.accounts)
            log('main', 'MAIN', `Accounts shuffled (shuffleAccounts=true)`)
        }

        // Only cluster when there's more than 1 cluster demanded (numeric)
        const clustersConfigured = (this.config as any)?.clusters ?? 0
        if (clustersConfigured > 1) {
            if (cluster.isPrimary) {
                this.runMaster()
            } else {
                this.runWorker()
            }
        } else {
            await this.runTasks(this.accounts)
        }
    }

    /**
     * Master logic:
     * - forks all workers immediately (one per chunk)
     * - computes a random delay for each worker within [clusterStaggerMinMs, clusterStaggerMaxMs]
     * - sends { chunk, index, delayMs } to the worker
     *
     * Default stagger window is 45 minutes -> 1.2 hours (72 minutes).
     * Overridable via config: clusterStaggerMinMs, clusterStaggerMaxMs
     */
    private runMaster() {
        log('main', 'MAIN-PRIMARY', 'Primary process started')

        const clustersNum = (this.config as any)?.clusters
        const numClusters = (typeof clustersNum === 'number' && clustersNum > 1) ? clustersNum : 1

        // chunk accounts evenly into number of clusters
        const accountChunks = this.utils.chunkArray(this.accounts, numClusters)

        // set activeWorkers to the number of chunks we will create
        this.activeWorkers = accountChunks.length

        // Stagger defaults: 45 minutes -> 1.2 hours (72 minutes)
        const defaultMinMs = 45 * 60 * 1000           // 45 minutes
        const defaultMaxMs = Math.round(1.2 * 60 * 60 * 1000) // 1.2 hours = 72 minutes -> 4,320,000 ms
        const staggerMinMs = (this.config as any)?.clusterStaggerMinMs ?? defaultMinMs
        const staggerMaxMs = (this.config as any)?.clusterStaggerMaxMs ?? defaultMaxMs

        log('main', 'MAIN-PRIMARY', `Forking ${accountChunks.length} worker(s). Each worker will wait a random delay between ${Math.round(staggerMinMs / 60000)}m and ${Math.round(staggerMaxMs / 60000)}m before starting its tasks.`)

        for (let i = 0; i < accountChunks.length; i++) {
            const worker = cluster.fork()
            const chunk = accountChunks[i]

            // Calculate per-worker random delay: all workers will receive a delay and will wait that long before starting.
            // This ensures that workers do NOT all start work at the same time relative to the main process.
            const delayMs = i === 0
                ? 0 // first worker starts immediately; change this to randomInt(staggerMinMs, staggerMaxMs) if you want first worker delayed too
                : randomInt(staggerMinMs, staggerMaxMs)

            // send chunk + delay to worker
            worker.send({ chunk, index: i, delayMs })
            log('main', 'MAIN-PRIMARY', `Worker ${worker.process.pid} forked for chunk ${i} (accounts: ${chunk?.length ?? 0}) with delay ${Math.round(delayMs / 60000)} minute(s).`)
        }

        cluster.on('exit', (worker, code, signal) => {
            this.activeWorkers -= 1
            log('main', 'MAIN-WORKER', `Worker ${worker.process.pid} destroyed | Code: ${code} | Signal: ${signal} | Active workers: ${this.activeWorkers}`, 'warn')

            // Check if all workers have exited
            if (this.activeWorkers === 0) {
                log('main', 'MAIN-WORKER', 'All workers destroyed. Exiting main process!', 'warn')
                process.exit(0)
            }
        })
    }

    private runWorker() {
        log('main', 'MAIN-WORKER', `Worker ${process.pid} spawned`)
        // Receive the chunk of accounts and delay from the master
        process.on('message', async (msg: any) => {
            const { chunk, index, delayMs } = msg || {}
            const accountsCount = Array.isArray(chunk) ? chunk.length : 0
            const workerIndex = typeof index !== 'undefined' ? index : 'unknown'

            log('main', 'MAIN-WORKER', `Worker ${process.pid} received chunk ${workerIndex} with ${accountsCount} account(s).`)

            const delay = typeof delayMs === 'number' && delayMs > 0 ? delayMs : 0
            if (delay > 0) {
                log('main', 'MAIN-WORKER', `Worker ${process.pid} waiting ${Math.round(delay / 60000)} minute(s) before starting tasks...`)
                await sleep(delay)
            } else {
                log('main', 'MAIN-WORKER', `Worker ${process.pid} starting tasks immediately.`)
            }

            await this.runTasks(chunk || [])
        })
    }

    /**
     * Runs tasks for the provided accounts array (sequentially).
     * Adds configurable random delays before starting each account and after finishing each account.
     * If an account fails login it will be marked with `doLater = true` (Login.handleFailedLogin)
     * and we will skip it during the first pass. After all accounts are processed we will perform
     * a single retry pass for those marked `doLater`.
     */
    private async runTasks(accounts: Account[]) {
        // read delay config and apply defaults
        const startMin = (this.config as any)?.accountStartDelayMinMs ?? 2000
        const startMax = (this.config as any)?.accountStartDelayMaxMs ?? 5000
        const finishMin = (this.config as any)?.accountFinishDelayMinMs ?? 1000
        const finishMax = (this.config as any)?.accountFinishDelayMaxMs ?? 3000

        // small optional per-account page delay to reduce flakiness
        const perAccountPageDelay = (this.config as any)?.perAccountPageDelayMs ?? 0

        for (const account of accounts) {
            log('main', 'MAIN-WORKER', `Preparing tasks for account ${account.email}`)

            // Random pre-start delay
            const preDelay = randomInt(startMin, startMax)
            log('main', 'MAIN-WORKER', `Waiting ${preDelay}ms before starting account ${account.email}`)
            if (this.utils && typeof (this.utils as any).wait === 'function') {
                await (this.utils as any).wait(preDelay)
            } else {
                await sleep(preDelay)
            }

            this.axios = new Axios(account.proxy)

            try {
                if (this.config.parallel) {
                    await Promise.all([
                        this.DesktopWithSmallDelay(account, perAccountPageDelay),
                        (async () => {
                            const mobileInstance = new MicrosoftRewardsBot(true)
                            // reuse axios/proxy for mobile instance
                            mobileInstance.axios = this.axios
                            // ensure config/accounts available
                            mobileInstance.config = this.config
                            mobileInstance.utils = this.utils
                            // initialize minimal things needed by Mobile
                            return mobileInstance.Mobile(account)
                        })()
                    ])
                } else {
                    this.isMobile = false
                    await this.DesktopWithSmallDelay(account, perAccountPageDelay)

                    this.isMobile = true
                    await this.MobileWithSmallDelay(account, perAccountPageDelay)
                }

                log('main', 'MAIN-WORKER', `Completed tasks for account ${account.email}`, 'log', 'green')
            } catch (err) {
                log('main', 'MAIN-WORKER', `Error in tasks for ${account.email}: ${err}`, 'error')
            }

            // Random post-finish delay
            const postDelay = randomInt(finishMin, finishMax)
            log('main', 'MAIN-WORKER', `Waiting ${postDelay}ms after finishing account ${account.email}`)
            if (this.utils && typeof (this.utils as any).wait === 'function') {
                await (this.utils as any).wait(postDelay)
            } else {
                await sleep(postDelay)
            }
        }

        // After first pass, check for accounts marked `doLater` and perform a single retry pass.
        const failedAccounts = (accounts || []).filter(a => (a as any).doLater)
        if (failedAccounts.length > 0) {
            log('main', 'MAIN-RETRY', `Found ${failedAccounts.length} account(s) marked doLater. Performing a single retry pass...`, 'log', 'yellow')

            for (const acc of failedAccounts) {
                // Clear the flag before retry so handleFailedLogin can re-mark if it fails again
                (acc as any).doLater = false

                log('main', 'MAIN-RETRY', `Retrying account ${acc.email}`)
                try {
                    if (this.config.parallel) {
                        await Promise.all([
                            this.DesktopWithSmallDelay(acc, perAccountPageDelay),
                            (async () => {
                                const mobileInstance = new MicrosoftRewardsBot(true)
                                mobileInstance.axios = this.axios
                                mobileInstance.config = this.config
                                mobileInstance.utils = this.utils
                                return mobileInstance.Mobile(acc)
                            })()
                        ])
                    } else {
                        this.isMobile = false
                        await this.DesktopWithSmallDelay(acc, perAccountPageDelay)

                        this.isMobile = true
                        await this.MobileWithSmallDelay(acc, perAccountPageDelay)
                    }
                } catch (err) {
                    log('main', 'MAIN-RETRY', `Retry failed for ${acc.email}: ${err}`, 'warn')
                }
            }

            const stillFailed = (accounts || []).filter(a => (a as any).doLater)
            if (stillFailed.length > 0) {
                log('main', 'MAIN-RETRY', `After retry, ${stillFailed.length} account(s) remain marked doLater. Please inspect them manually.`, 'error')
            } else {
                log('main', 'MAIN-RETRY', 'Retry pass succeeded for all previously failed accounts.', 'log', 'green')
            }
        }

        log(this.isMobile, 'MAIN-PRIMARY', 'Completed tasks for ALL accounts', 'log', 'green')
        process.exit()
    }

    // wrapper to optionally add a small wait before/after Desktop run to reduce flakiness
    private async DesktopWithSmallDelay(account: Account, pageDelayMs: number) {
        if (pageDelayMs && pageDelayMs > 0) {
            await (this.utils && (this.utils as any).wait ? (this.utils as any).wait(pageDelayMs) : sleep(pageDelayMs))
        }
        await this.Desktop(account)
        if (pageDelayMs && pageDelayMs > 0) {
            await (this.utils && (this.utils as any).wait ? (this.utils as any).wait(pageDelayMs) : sleep(pageDelayMs))
        }
    }

    private async MobileWithSmallDelay(account: Account, pageDelayMs: number) {
        if (pageDelayMs && pageDelayMs > 0) {
            await (this.utils && (this.utils as any).wait ? (this.utils as any).wait(pageDelayMs) : sleep(pageDelayMs))
        }
        await this.Mobile(account)
        if (pageDelayMs && pageDelayMs > 0) {
            await (this.utils && (this.utils as any).wait ? (this.utils as any).wait(pageDelayMs) : sleep(pageDelayMs))
        }
    }

    // Desktop
    async Desktop(account: Account) {
        const browser = await this.browserFactory.createBrowser(account.proxy, account.email)
        this.homePage = await browser.newPage()

        log(this.isMobile, 'MAIN', 'Starting browser')

        // Login into MS Rewards, then go to rewards homepage
        await this.login.login(this.homePage, account.email, account.password)

        // If login failed, Login.handleFailedLogin will set `doLater = true` on the account.
        if ((account as any).doLater) {
            log(this.isMobile, 'MAIN', `Login failed for ${account.email}. Skipping Desktop tasks and continuing.`, 'warn')
            // ensure browser closed
            await this.browser.func.closeBrowser(browser, account.email)
            return
        }

        await this.browser.func.goHome(this.homePage)

        const data = await this.browser.func.getDashboardData()

        this.pointsInitial = data.userStatus.availablePoints

        log(this.isMobile, 'MAIN-POINTS', `Current point count: ${this.pointsInitial}`)

        const browserEnarablePoints = await this.browser.func.getBrowserEarnablePoints()

        // Tally all the desktop points
        this.pointsCanCollect = browserEnarablePoints.dailySetPoints +
            browserEnarablePoints.desktopSearchPoints
            + browserEnarablePoints.morePromotionsPoints

        log(this.isMobile, 'MAIN-POINTS', `You can earn ${this.pointsCanCollect} points today`)

        // If runOnZeroPoints is false and 0 points to earn, don't continue
        if (!this.config.runOnZeroPoints && this.pointsCanCollect === 0) {
            log(this.isMobile, 'MAIN', 'No points to earn and "runOnZeroPoints" is set to "false", stopping!', 'log', 'yellow')

            // Close desktop browser
            await this.browser.func.closeBrowser(browser, account.email)
            return
        }

        // Open a new tab to where the tasks are going to be completed
        const workerPage = await browser.newPage()

        // Go to homepage on worker page
        await this.browser.func.goHome(workerPage)

        // Complete daily set
        if (this.config.workers.doDailySet) {
            await this.workers.doDailySet(workerPage, data)
        }

        // Complete more promotions
        if (this.config.workers.doMorePromotions) {
            await this.workers.doMorePromotions(workerPage, data)
        }

        // Complete punch cards
        if (this.config.workers.doPunchCards) {
            await this.workers.doPunchCard(workerPage, data)
        }

        // Do desktop searches
        if (this.config.workers.doDesktopSearch) {
            await this.activities.doSearch(workerPage, data)
        }

        // Save cookies
        await saveSessionData(this.config.sessionPath, browser, account.email, this.isMobile)

        // Close desktop browser
        await this.browser.func.closeBrowser(browser, account.email)
        return
    }

    // Mobile
    async Mobile(account: Account) {
        const browser = await this.browserFactory.createBrowser(account.proxy, account.email)
        this.homePage = await browser.newPage()

        log(this.isMobile, 'MAIN', 'Starting browser')

        // Login into MS Rewards, then go to rewards homepage
        await this.login.login(this.homePage, account.email, account.password)

        // If login failed, skip mobile tasks
        if ((account as any).doLater) {
            log(this.isMobile, 'MAIN', `Login failed for ${account.email}. Skipping Mobile tasks and continuing.`, 'warn')
            await this.browser.func.closeBrowser(browser, account.email)
            return
        }

        this.accessToken = await this.login.getMobileAccessToken(this.homePage, account.email)

        await this.browser.func.goHome(this.homePage)

        const data = await this.browser.func.getDashboardData()

        const browserEnarablePoints = await this.browser.func.getBrowserEarnablePoints()
        const appEarnablePoints = await this.browser.func.getAppEarnablePoints(this.accessToken)

        this.pointsCanCollect = browserEnarablePoints.mobileSearchPoints + appEarnablePoints.totalEarnablePoints

        log(this.isMobile, 'MAIN-POINTS', `You can earn ${this.pointsCanCollect} points today (Browser: ${browserEnarablePoints.mobileSearchPoints} points, App: ${appEarnablePoints.totalEarnablePoints} points)`)

        // If runOnZeroPoints is false and 0 points to earn, don't continue
        if (!this.config.runOnZeroPoints && this.pointsCanCollect === 0) {
            log(this.isMobile, 'MAIN', 'No points to earn and "runOnZeroPoints" is set to "false", stopping!', 'log', 'yellow')

            // Close mobile browser
            await this.browser.func.closeBrowser(browser, account.email)
            return
        }

        // Do daily check in
        if (this.config.workers.doDailyCheckIn) {
            await this.activities.doDailyCheckIn(this.accessToken, data)
        }

        // Do read to earn
        if (this.config.workers.doReadToEarn) {
            await this.activities.doReadToEarn(this.accessToken, data)
        }

        // Do mobile searches
        if (this.config.workers.doMobileSearch) {
            // If no mobile searches data found, stop (Does not always exist on new accounts)
            if (data.userStatus.counters.mobileSearch) {
                // Open a new tab to where the tasks are going to be completed
                const workerPage = await browser.newPage()

                // Go to homepage on worker page
                await this.browser.func.goHome(workerPage)

                await this.activities.doSearch(workerPage, data)

                // Fetch current search points
                const mobileSearchPoints = (await this.browser.func.getSearchPoints()).mobileSearch?.[0]

                if (mobileSearchPoints && (mobileSearchPoints.pointProgressMax - mobileSearchPoints.pointProgress) > 0) {
                    // Increment retry count
                    this.mobileRetryAttempts++
                }

                // Exit if retries are exhausted
                if (this.mobileRetryAttempts > this.config.searchSettings.retryMobileSearchAmount) {
                    log(this.isMobile, 'MAIN', `Max retry limit of ${this.config.searchSettings.retryMobileSearchAmount} reached. Exiting retry loop`, 'warn')
                } else if (this.mobileRetryAttempts !== 0) {
                    log(this.isMobile, 'MAIN', `Attempt ${this.mobileRetryAttempts}/${this.config.searchSettings.retryMobileSearchAmount}: Unable to complete mobile searches, bad User-Agent? Increase search delay? Retrying...`, 'log', 'yellow')

                    // Close mobile browser
                    await this.browser.func.closeBrowser(browser, account.email)

                    // Create a new browser and try
                    await this.Mobile(account)
                    return
                }
            } else {
                log(this.isMobile, 'MAIN', 'Unable to fetch search points, your account is most likely too "new" for this! Try again later!', 'warn')
            }
        }

        const afterPointAmount = await this.browser.func.getCurrentPoints()

        log(this.isMobile, 'MAIN-POINTS', `The script collected ${afterPointAmount - this.pointsInitial} points today`)

        // Close mobile browser
        await this.browser.func.closeBrowser(browser, account.email)
        return
    }
}

async function main() {
    const rewardsBot = new MicrosoftRewardsBot(false)

    try {
        await rewardsBot.initialize()
        await rewardsBot.run()
    } catch (error) {
        log(false, 'MAIN-ERROR', `Error running desktop bot: ${error}`, 'error')
    }
}

// Start the bots
main().catch(error => {
    log('main', 'MAIN-ERROR', `Error running bots: ${error}`, 'error')
    process.exit(1)
})
