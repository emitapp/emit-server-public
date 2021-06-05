import * as functions from 'firebase-functions';
import axios from 'axios'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const querystring = require('querystring');

export const subscribeNewUserToNewsletters = functions.auth.user().onCreate(async (user) => {
    if (!user.email) return;
    if (process.env.FUNCTIONS_EMULATOR) return;
    if (functions.config().env.newsletter.is_prod_server != "yes") return;
    await subscribeToList(user.email, functions.config().env.newsletter.news_newsletter_id)
    await subscribeToList(user.email, functions.config().env.newsletter.support_newsletter_id)
});

export const unsubscribeDeletedUserFromNewsletters = functions.auth.user().onDelete(async (user) => {
    if (!user.email) return;
    if (process.env.FUNCTIONS_EMULATOR) return;
    if (functions.config().env.newsletter.is_prod_server != "yes") return;
    await unsubscribeFromList(user.email, functions.config().env.newsletter.news_newsletter_id)
    await unsubscribeFromList(user.email, functions.config().env.newsletter.support_newsletter_id)
});

//https://sendy.co/api
const subscribeToList = async (email: string, list: string) => {
    const endpoint = functions.config().env.newsletter.sendy_url
    const apiKey = functions.config().env.newsletter.sendy_api_key
    const headers = {
        'Content-Type': 'application/x-www-form-urlencoded',
    }

    return await axios.post(
        `${endpoint}/subscribe`,
        querystring.stringify({
            api_key: apiKey,
            email: email,
            list,
            boolean: "true"
        }),
        { headers }
    )
}

const unsubscribeFromList = async (email: string, list: string) => {
    const endpoint = functions.config().env.newsletter.sendy_url
    const apiKey = functions.config().env.newsletter.sendy_api_key
    const headers = {
        'Content-Type': 'application/x-www-form-urlencoded',
    }

    return await axios.post(
        `${endpoint}/unsubscribe`,
        querystring.stringify({
            api_key: apiKey,
            email: email,
            list,
            boolean: "true"
        }), { headers }
    )
}