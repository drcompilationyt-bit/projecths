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

// Relay-aware logging: calls the original logger and also forwards worker logs to master via IPC
const originalLog = log
function rlog(isMobileFlag: any, tag: string, message: string, level?: 'log' | 'warn' | 'error', color?: string | undefined) {
    try {
        // call original logger (keeps existing formatting behavior)
        // cast color to any to satisfy original logger's expected color type (could be Chalk keys or similar)
        originalLog(isMobileFlag, tag, message, level, color as any)
    } catch (e) {
        // fallback to console if logger crashes
        try { console.log(`${tag}: ${message}`) } catch {}
    }

    // If this is a worker, forward the log to the master so all logs appear in the main terminal
    if (!cluster.isPrimary && typeof process.send === 'function') {
        try {
            process.send({
                __workerLog: true,
                payload: {
                    pid: process.pid,
                    timestamp: new Date().toISOString(),
                    isMobileFlag,
                    tag,
                    message,
                    level,
                    color
                }
            })
        } catch (e) {
            // ignore send errors
        }
    }
}

// Main bot class
export class MicrosoftRewardsBot {
    public log: typeof rlog
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
        this.log = rlog

        this.accounts = []
        this.utils = new Util()
        this.workers = new Workers(this)
        this.browser = {
            func: new BrowserFunc(this),
            utils: new BrowserUtil(this)
        }
        this.config = loadConfig()
        this.activeWorkers = this.config.clusters
        this.mobileRetryAttempts = 0

        // If we're the master process, set up a listener so any forwarded worker logs are printed nicely
        if (cluster.isPrimary) {
            // cluster.workers will populate as workers are forked. We also attach listeners in runMasterWithStagger per worker.
        }

        // In the worker process, optionally patch process.stdout/stderr so libraries that write directly to them are visible.
        if (!cluster.isPrimary) {
            // ensure unhandled rejections surface
            process.on('unhandledRejection', (reason) => {
                try { rlog(this.isMobile, 'UNHANDLED', `Unhandled Rejection: ${String(reason)}`, 'error') } catch {}
            })
        }
    }

    async initialize() {
        this.accounts = loadAccounts()
        // attach accounts to config so other parts can use them if needed
        ;(this.config as any).accounts = this.accounts
    }

    async run() {
        rlog('main', 'MAIN', `Bot started with ${this.config.clusters} clusters`)

        // Optionally shuffle accounts globally (configurable)
        const shouldShuffle = (this.config as any)?.shuffleAccounts ?? false
        if (shouldShuffle) {
            shuffleArray(this.accounts)
            rlog('main', 'MAIN', `Accounts shuffled (shuffleAccounts=true)`)
        }

        // If clusters <= 1 just run single-process logic
        if (this.config.clusters <= 1) {
            await this.runTasks(this.accounts)
            return
        }

        // Limit clusters to number of accounts so we don't spawn empty workers
        const requestedClusters = this.config.clusters
        const effectiveClusters = Math.max(1, Math.min(requestedClusters, this.accounts.length))
        if (effectiveClusters !== requestedClusters) {
            rlog('main', 'MAIN', `Adjusted clusters from ${requestedClusters} to ${effectiveClusters} to match account count`, 'warn')
            this.config.clusters = effectiveClusters
        }

        if (cluster.isPrimary) {
            this.runMasterWithStagger()
        } else {
            this.runWorker()
        }
    }

    /**
     * Master: fork workers and provide each worker its own chunk of accounts plus an optional startDelay.
     * The first worker starts immediately, remaining workers will stagger their start between 30-60 minutes.
     * Also attaches message listeners to workers so forwarded logs are printed to the master terminal.
     */
    private runMasterWithStagger() {
        rlog(false, 'MAIN-PRIMARY', 'Primary process started')

        // Evenly chunk accounts into number of clusters
        const accountChunks = this.utils.chunkArray(this.accounts, this.config.clusters)

        // set activeWorkers to the number of chunks we will create
        this.activeWorkers = accountChunks.length

        // constants for staggered start (30 - 60 minutes)
        const STAGGER_MIN_MS = 30 * 60 * 1000 // 30 minutes
        const STAGGER_MAX_MS = 60 * 60 * 1000 // 60 minutes

        for (let i = 0; i < accountChunks.length; i++) {
            const worker = cluster.fork()
            const chunk = accountChunks[i]!

            // Attach message listener immediately so we don't miss any forwarded logs
            worker.on('message', (msg: any) => {
                if (msg && msg.__workerLog && msg.payload) {
                    const p = msg.payload
                    // Print a concise, timestamped, prefixed log line to master terminal
                    // Format: [worker PID] 2025-09-18T... [TAG] message
                    const line = `[worker ${worker.process.pid}] ${p.timestamp} [${p.tag}] ${p.message}`
                    // Use console directly so master terminal shows everything even if original logger is silenced
                    console.log(line)
                }
            })

            // First worker starts immediately; others get a randomized delay
            const startDelay = (i === 0) ? 0 : randomInt(STAGGER_MIN_MS, STAGGER_MAX_MS)

            // Attach metadata so worker can log/know its place
            const message = {
                chunk,
                startDelay,
                workerIndex: i + 1,
                totalWorkers: accountChunks.length
            }

            // send the chunk and startDelay
            worker.send(message)

            rlog(false, 'MAIN-PRIMARY', `Forked worker ${worker.process.pid} assigned ${chunk.length} account(s) | startDelay=${startDelay}ms | worker ${i + 1}/${accountChunks.length}`)
        }

        // Listen for worker exits and track active count
        cluster.on('exit', (worker, code, signal) => {
            this.activeWorkers -= 1

            rlog(false, 'MAIN-WORKER', `Worker ${worker.process.pid} exited | Code: ${code} | Signal: ${signal} | Active workers remaining: ${this.activeWorkers}`, 'warn')

            // Check if all workers have exited
            if (this.activeWorkers === 0) {
                rlog(false, 'MAIN-WORKER', 'All workers destroyed. Exiting main process!', 'warn')
                process.exit(0)
            }
        })

        // Graceful shutdown handling: relay to workers
        process.on('SIGINT', () => {
            rlog(false, 'MAIN-PRIMARY', 'SIGINT received. Asking workers to shut down gracefully...', 'warn')
            for (const id in cluster.workers) {
                cluster.workers[id]?.kill('SIGINT')
            }
            // if workers don't exit, master will exit on the 'exit' events above
        })

        // Catch unhandled errors in master to avoid silent death
        process.on('unhandledRejection', (reason) => {
            rlog(false, 'MAIN-PRIMARY', `Unhandled Rejection in master: ${reason}`, 'error')
        })
    }

    private runWorker() {
        rlog('main', 'MAIN-WORKER', `Worker ${process.pid} spawned`)
        // Receive the chunk of accounts (and optional startDelay) from the master
        process.on('message', async ({ chunk, startDelay, workerIndex, totalWorkers }: any) => {
            try {
                const idx = workerIndex ?? 0
                const total = totalWorkers ?? 0

                if (startDelay && startDelay > 0) {
                    rlog(this.isMobile, 'MAIN-WORKER', `Worker ${process.pid} (index ${idx}/${total}) will wait ${startDelay}ms before starting...`, 'log', 'yellow')

                    // Use utils.wait if available to be consistent with existing waits
                    if (this.utils && typeof (this.utils as any).wait === 'function') {
                        await (this.utils as any).wait(startDelay)
                    } else {
                        await sleep(startDelay)
                    }
                } else {
                    rlog(this.isMobile, 'MAIN-WORKER', `Worker ${process.pid} (index ${idx}/${total}) starting immediately...`)
                }

                await this.runTasks(chunk)
            } catch (err) {
                rlog(this.isMobile, 'MAIN-WORKER', `Worker ${process.pid} encountered an error: ${err}`, 'error')
                // ensure worker exits with non-zero so master can detect
                process.exit(1)
            }
        })

        // Extra graceful cleanup on worker
        process.on('SIGINT', () => {
            rlog(this.isMobile, 'MAIN-WORKER', `Worker ${process.pid} received SIGINT. Exiting...`, 'warn')
            process.exit(0)
        })

        process.on('unhandledRejection', (reason) => {
            rlog(this.isMobile, 'MAIN-WORKER', `Unhandled Rejection in worker: ${reason}`, 'error')
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
            rlog('main', 'MAIN-WORKER', `Preparing tasks for account ${account.email}`)

            // Random pre-start delay
            const preDelay = randomInt(startMin, startMax)
            rlog('main', 'MAIN-WORKER', `Waiting ${preDelay}ms before starting account ${account.email}`)
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

                rlog('main', 'MAIN-WORKER', `Completed tasks for account ${account.email}`, 'log', 'green')
            } catch (err) {
                rlog('main', 'MAIN-WORKER', `Error in tasks for ${account.email}: ${err}`, 'error')
            }

            // Random post-finish delay
            const postDelay = randomInt(finishMin, finishMax)
            rlog('main', 'MAIN-WORKER', `Waiting ${postDelay}ms after finishing account ${account.email}`)
            if (this.utils && typeof (this.utils as any).wait === 'function') {
                await (this.utils as any).wait(postDelay)
            } else {
                await sleep(postDelay)
            }
        }

        // After first pass, check for accounts marked `doLater` and perform a single retry pass.
        const failedAccounts = (accounts || []).filter(a => (a as any).doLater)
        if (failedAccounts.length > 0) {
            rlog('main', 'MAIN-RETRY', `Found ${failedAccounts.length} account(s) marked doLater. Performing a single retry pass...`, 'log', 'yellow')

            for (const acc of failedAccounts) {
                // Clear the flag before retry so handleFailedLogin can re-mark if it fails again
                (acc as any).doLater = false

                rlog('main', 'MAIN-RETRY', `Retrying account ${acc.email}`)
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
                    rlog('main', 'MAIN-RETRY', `Retry failed for ${acc.email}: ${err}`, 'warn')
                }
            }

            const stillFailed = (accounts || []).filter(a => (a as any).doLater)
            if (stillFailed.length > 0) {
                rlog('main', 'MAIN-RETRY', `After retry, ${stillFailed.length} account(s) remain marked doLater. Please inspect them manually.`, 'error')
            } else {
                rlog('main', 'MAIN-RETRY', 'Retry pass succeeded for all previously failed accounts.', 'log', 'green')
            }
        }

        rlog(this.isMobile, 'MAIN-PRIMARY', 'Completed tasks for ALL accounts', 'log', 'green')
        // Worker process exits when it finishes its assigned chunk
        process.exit(0)
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

        rlog(this.isMobile, 'MAIN', 'Starting browser')

        // Login into MS Rewards, then go to rewards homepage
        await this.login.login(this.homePage, account.email, account.password)

        // If login failed, Login.handleFailedLogin will set `doLater = true` on the account.
        if ((account as any).doLater) {
            rlog(this.isMobile, 'MAIN', `Login failed for ${account.email}. Skipping Desktop tasks and continuing.`, 'warn')
            // ensure browser closed
            await this.browser.func.closeBrowser(browser, account.email)
            return
        }

        await this.browser.func.goHome(this.homePage)

        const data = await this.browser.func.getDashboardData()

        this.pointsInitial = data.userStatus.availablePoints

        rlog(this.isMobile, 'MAIN-POINTS', `Current point count: ${this.pointsInitial}`)

        const browserEnarablePoints = await this.browser.func.getBrowserEarnablePoints()

        // Tally all the desktop points
        this.pointsCanCollect = browserEnarablePoints.dailySetPoints +
            browserEnarablePoints.desktopSearchPoints
            + browserEnarablePoints.morePromotionsPoints

        rlog(this.isMobile, 'MAIN-POINTS', `You can earn ${this.pointsCanCollect} points today`)

        // If runOnZeroPoints is false and 0 points to earn, don't continue
        if (!this.config.runOnZeroPoints && this.pointsCanCollect === 0) {
            rlog(this.isMobile, 'MAIN', 'No points to earn and "runOnZeroPoints" is set to "false", stopping!', 'log', 'yellow')

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

        rlog(this.isMobile, 'MAIN', 'Starting browser')

        // Login into MS Rewards, then go to rewards homepage
        await this.login.login(this.homePage, account.email, account.password)

        // If login failed, skip mobile tasks
        if ((account as any).doLater) {
            rlog(this.isMobile, 'MAIN', `Login failed for ${account.email}. Skipping Mobile tasks and continuing.`, 'warn')
            await this.browser.func.closeBrowser(browser, account.email)
            return
        }

        this.accessToken = await this.login.getMobileAccessToken(this.homePage, account.email)

        await this.browser.func.goHome(this.homePage)

        const data = await this.browser.func.getDashboardData()

        const browserEnarablePoints = await this.browser.func.getBrowserEarnablePoints()
        const appEarnablePoints = await this.browser.func.getAppEarnablePoints(this.accessToken)

        this.pointsCanCollect = browserEnarablePoints.mobileSearchPoints + appEarnablePoints.totalEarnablePoints

        rlog(this.isMobile, 'MAIN-POINTS', `You can earn ${this.pointsCanCollect} points today (Browser: ${browserEnarablePoints.mobileSearchPoints} points, App: ${appEarnablePoints.totalEarnablePoints} points)`)

        // If runOnZeroPoints is false and 0 points to earn, don't continue
        if (!this.config.runOnZeroPoints && this.pointsCanCollect === 0) {
            rlog(this.isMobile, 'MAIN', 'No points to earn and "runOnZeroPoints" is set to "false", stopping!', 'log', 'yellow')

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
                    rlog(this.isMobile, 'MAIN', `Max retry limit of ${this.config.searchSettings.retryMobileSearchAmount} reached. Exiting retry loop`, 'warn')
                } else if (this.mobileRetryAttempts !== 0) {
                    rlog(this.isMobile, 'MAIN', `Attempt ${this.mobileRetryAttempts}/${this.config.searchSettings.retryMobileSearchAmount}: Unable to complete mobile searches, bad User-Agent? Increase search delay? Retrying...`, 'log', 'yellow')

                    // Close mobile browser
                    await this.browser.func.closeBrowser(browser, account.email)

                    // Create a new browser and try
                    await this.Mobile(account)
                    return
                }
            } else {
                rlog(this.isMobile, 'MAIN', 'Unable to fetch search points, your account is most likely too "new" for this! Try again later!', 'warn')
            }
        }

        const afterPointAmount = await this.browser.func.getCurrentPoints()

        rlog(this.isMobile, 'MAIN-POINTS', `The script collected ${afterPointAmount - this.pointsInitial} points today`)

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
        rlog(false, 'MAIN-ERROR', `Error running desktop bot: ${error}`, 'error')
    }
}

// Start the bots
main().catch(error => {
    rlog('main', 'MAIN-ERROR', `Error running bots: ${error}`, 'error')
    process.exit(1)
})
