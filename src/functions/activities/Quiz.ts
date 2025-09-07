import { Page } from 'rebrowser-playwright'

import { Workers } from '../Workers'


export class Quiz extends Workers {

    async doQuiz(page: Page) {
        this.bot.log(this.bot.isMobile, 'QUIZ', 'Trying to complete quiz')

        try {
            // Check if the quiz has been started or not
            const quizNotStarted = await page.waitForSelector('#rqStartQuiz', { state: 'visible', timeout: 2000 }).then(() => true).catch(() => false)
            if (quizNotStarted) {
                // Human-like delay before starting quiz (1-2 seconds)
                await this.bot.utils.wait(this.bot.utils.randomNumber(1000, 2000))
                await page.click('#rqStartQuiz')
            } else {
                this.bot.log(this.bot.isMobile, 'QUIZ', 'Quiz has already been started, trying to finish it')
            }

            // Human-like delay after starting/continuing quiz (2-4 seconds)
            await this.bot.utils.wait(this.bot.utils.randomNumber(2000, 4000))

            let quizData = await this.bot.browser.func.getQuizData(page)
            const questionsRemaining = quizData.maxQuestions - quizData.CorrectlyAnsweredQuestionCount // Amount of questions remaining

            // All questions
            for (let question = 0; question < questionsRemaining; question++) {

                if (quizData.numberOfOptions === 8) {
                    const answers: string[] = []

                    for (let i = 0; i < quizData.numberOfOptions; i++) {
                        const answerSelector = await page.waitForSelector(`#rqAnswerOption${i}`, { state: 'visible', timeout: 10000 })
                        const answerAttribute = await answerSelector?.evaluate(el => el.getAttribute('iscorrectoption'))

                        if (answerAttribute && answerAttribute.toLowerCase() === 'true') {
                            answers.push(`#rqAnswerOption${i}`)
                        }
                    }

                    // Click the answers
                    for (const answer of answers) {
                        await page.waitForSelector(answer, { state: 'visible', timeout: 2000 })

                        // Human-like delay before clicking each answer (0.5-1.5 seconds)
                        await this.bot.utils.wait(this.bot.utils.randomNumber(500, 1500))

                        // Click the answer on page
                        await page.click(answer)

                        const refreshSuccess = await this.bot.browser.func.waitForQuizRefresh(page)
                        if (!refreshSuccess) {
                            await page.close()
                            this.bot.log(this.bot.isMobile, 'QUIZ', 'An error occurred, refresh was unsuccessful', 'error')
                            return
                        }

                        // Human-like delay after clicking (1-3 seconds)
                        await this.bot.utils.wait(this.bot.utils.randomNumber(1000, 3000))
                    }

                    // Other type quiz, lightspeed
                } else if ([2, 3, 4].includes(quizData.numberOfOptions)) {
                    quizData = await this.bot.browser.func.getQuizData(page) // Refresh Quiz Data

                    // Human-like delay before processing question (1-2 seconds)
                    await this.bot.utils.wait(this.bot.utils.randomNumber(1000, 2000))

                    const correctOption = quizData.correctAnswer

                    for (let i = 0; i < quizData.numberOfOptions; i++) {

                        const answerSelector = await page.waitForSelector(`#rqAnswerOption${i}`, { state: 'visible', timeout: 10000 })
                        const dataOption = await answerSelector?.evaluate(el => el.getAttribute('data-option'))

                        if (dataOption === correctOption) {
                            // Human-like delay before clicking correct answer (0.8-2 seconds)
                            await this.bot.utils.wait(this.bot.utils.randomNumber(800, 2000))

                            // Click the answer on page
                            await page.click(`#rqAnswerOption${i}`)

                            const refreshSuccess = await this.bot.browser.func.waitForQuizRefresh(page)
                            if (!refreshSuccess) {
                                await page.close()
                                this.bot.log(this.bot.isMobile, 'QUIZ', 'An error occurred, refresh was unsuccessful', 'error')
                                return
                            }

                            // Human-like delay after clicking (1.5-3.5 seconds)
                            await this.bot.utils.wait(this.bot.utils.randomNumber(1500, 3500))
                        }
                    }
                    // Human-like delay between questions (2-4 seconds)
                    await this.bot.utils.wait(this.bot.utils.randomNumber(2000, 4000))
                }
            }

            // Done with quiz - human-like delay before closing (2-5 seconds)
            await this.bot.utils.wait(this.bot.utils.randomNumber(2000, 5000))
            await page.close()

            this.bot.log(this.bot.isMobile, 'QUIZ', 'Completed the quiz successfully')
        } catch (error) {
            await page.close()
            this.bot.log(this.bot.isMobile, 'QUIZ', 'An error occurred:' + error, 'error')
        }
    }

}