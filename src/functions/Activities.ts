import { Page } from 'rebrowser-playwright'
import { MicrosoftRewardsBot } from '../index'
import { Search } from './activities/Search'
import { ABC } from './activities/ABC'
import { Poll } from './activities/Poll'
import { Quiz } from './activities/Quiz'
import { ThisOrThat } from './activities/ThisOrThat'
import { UrlReward } from './activities/UrlReward'
import { SearchOnBing } from './activities/SearchOnBing'
import { ReadToEarn } from './activities/ReadToEarn'
import { DailyCheckIn } from './activities/DailyCheckIn'
import { DashboardData, MorePromotion, PromotionalItem } from '../interface/DashboardData'

// Utility function to mimic human-like delay
const randomDelay = (minMs: number = 1000, maxMs: number = 5000): Promise<void> => {
    const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs
    return new Promise(resolve => setTimeout(resolve, delay))
}

export default class Activities {
    private bot: MicrosoftRewardsBot

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    doSearch = async (page: Page, data: DashboardData): Promise<void> => {
        const search = new Search(this.bot)
        await search.doSearch(page, data)
        await randomDelay(1000, 2000) // Mimic pause after search
    }

    doABC = async (page: Page): Promise<void> => {
        const abc = new ABC(this.bot)
        await abc.doABC(page)
        await randomDelay(2000, 3000) // Longer pause for interactive content
    }

    doPoll = async (page: Page): Promise<void> => {
        const poll = new Poll(this.bot)
        await poll.doPoll(page)
        await randomDelay(1000, 2000)
    }

    doThisOrThat = async (page: Page): Promise<void> => {
        const thisOrThat = new ThisOrThat(this.bot)
        await thisOrThat.doThisOrThat(page)
        await randomDelay(1000, 2000) // Longer due to quiz nature
    }

    doQuiz = async (page: Page): Promise<void> => {
        const quiz = new Quiz(this.bot)
        await quiz.doQuiz(page)
        await randomDelay(1000, 2000)
    }

    doUrlReward = async (page: Page): Promise<void> => {
        const urlReward = new UrlReward(this.bot)
        await urlReward.doUrlReward(page)
        await randomDelay(1000, 2000)
    }

    doSearchOnBing = async (page: Page, activity: MorePromotion | PromotionalItem): Promise<void> => {
        const searchOnBing = new SearchOnBing(this.bot)
        await searchOnBing.doSearchOnBing(page, activity)
        await randomDelay(1000, 2000)
    }

    doReadToEarn = async (accessToken: string, data: DashboardData): Promise<void> => {
        const readToEarn = new ReadToEarn(this.bot)
        await readToEarn.doReadToEarn(accessToken, data)
    }

    doDailyCheckIn = async (accessToken: string, data: DashboardData): Promise<void> => {
        const dailyCheckIn = new DailyCheckIn(this.bot)
        await dailyCheckIn.doDailyCheckIn(accessToken, data)
        await randomDelay(1000, 2000)
    }
}