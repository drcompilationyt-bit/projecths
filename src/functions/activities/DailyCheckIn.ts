import { randomBytes } from 'crypto'
import { AxiosRequestConfig } from 'axios'

import { Workers } from '../Workers'

import { DashboardData } from '../../interface/DashboardData'

export class DailyCheckIn extends Workers {
    // Humanized defaults (ms)
    private static readonly DEFAULT_MIN_DELAY_MS = 800
    private static readonly DEFAULT_MAX_DELAY_MS = 2200
    private static readonly DEFAULT_RETRIES = 3
    private static readonly DEFAULT_BASE_BACKOFF_MS = 800

    public async doDailyCheckIn(accessToken: string, data: DashboardData) {
        // use explicit 'log' level which matches your bot.log signature
        this.bot.log(this.bot.isMobile, 'DAILY-CHECK-IN', 'Starting Daily Check In', 'log')

        try {
            // Determine geo locale safely
            let geoLocale = data?.userProfile?.attributes?.country ?? 'us'
            geoLocale = (this.bot.config?.searchSettings?.useGeoLocaleQueries && geoLocale.length === 2)
                ? geoLocale.toLowerCase()
                : 'us'

            // human-like randomized delay before attempting the claim
            const minDelay = (this.bot.config as any)?.dailyCheckInMinDelayMs ?? DailyCheckIn.DEFAULT_MIN_DELAY_MS
            const maxDelay = (this.bot.config as any)?.dailyCheckInMaxDelayMs ?? DailyCheckIn.DEFAULT_MAX_DELAY_MS
            const initialWait = this.bot.utils?.randomNumber
                ? this.bot.utils.randomNumber(minDelay, maxDelay)
                : Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay

            this.bot.log(this.bot.isMobile, 'DAILY-CHECK-IN', `Waiting ${initialWait}ms before claim (humanized)`, 'log')
            await this.bot.utils.wait(initialWait)

            const jsonData = {
                amount: 1,
                country: geoLocale,
                id: randomBytes(64).toString('hex'),
                type: 101,
                attributes: {
                    offerid: 'Gamification_Sapphire_DailyCheckIn'
                }
            }

            const claimRequestBase: AxiosRequestConfig = {
                url: 'https://prod.rewardsplatform.microsoft.com/dapi/me/activities',
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'X-Rewards-Country': geoLocale,
                    'X-Rewards-Language': 'en'
                },
                data: JSON.stringify(jsonData)
            }

            const maxRetries = (this.bot.config as any)?.dailyCheckInRetries ?? DailyCheckIn.DEFAULT_RETRIES
            const baseBackoff = (this.bot.config as any)?.dailyCheckInBackoffMs ?? DailyCheckIn.DEFAULT_BASE_BACKOFF_MS

            let attempt = 0
            let claimedPoint = 0
            let lastError: any = null

            while (attempt < maxRetries) {
                attempt++
                try {
                    this.bot.log(this.bot.isMobile, 'DAILY-CHECK-IN', `Attempt ${attempt} to claim daily check-in`, 'log')
                    const claimRequest = {
                        ...claimRequestBase,
                        timeout: (this.bot.config as any)?.axiosTimeoutMs ?? 15000
                    }

                    const claimResponse = await this.bot.axios.request(claimRequest)
                    const respData = claimResponse?.data ?? {}

                    // safe parse for claimed points
                    const p = respData?.response?.activity?.p
                    claimedPoint = Number.isFinite(Number(p)) ? Number(p) : (parseInt(p as any) || 0)

                    if (claimedPoint > 0) {
                        this.bot.log(this.bot.isMobile, 'DAILY-CHECK-IN', `Claimed ${claimedPoint} points`, 'log')
                    } else {
                        // Either already claimed or response doesn't contain points
                        this.bot.log(this.bot.isMobile, 'DAILY-CHECK-IN', 'Already claimed today or no points returned', 'log')
                    }

                    // success (don't retry further)
                    return
                } catch (err) {
                    lastError = err
                    this.bot.log(this.bot.isMobile, 'DAILY-CHECK-IN', `Claim attempt ${attempt} failed: ${err}`, 'warn')

                    if (attempt < maxRetries) {
                        // exponential backoff + jitter
                        const backoffBase = baseBackoff * Math.pow(2, attempt - 1)
                        const jitter = (this.bot.utils?.randomNumber)
                            ? this.bot.utils.randomNumber(0, backoffBase)
                            : Math.floor(Math.random() * (backoffBase + 1))
                        const waitMs = backoffBase + jitter

                        this.bot.log(this.bot.isMobile, 'DAILY-CHECK-IN', `Waiting ${waitMs}ms before retry ${attempt + 1}`, 'log')
                        await this.bot.utils.wait(waitMs)
                    }
                }
            }

            // all attempts exhausted
            this.bot.log(this.bot.isMobile, 'DAILY-CHECK-IN', `Failed to claim after ${maxRetries} attempts: ${lastError}`, 'error')
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'DAILY-CHECK-IN', 'An error occurred: ' + error, 'error')
        }
    }
}
