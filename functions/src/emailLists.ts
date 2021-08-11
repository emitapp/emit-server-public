import * as functions from 'firebase-functions';
import axios from 'axios'
import { builtInEnvVariables, envVariables } from './utils/env/envVariables';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const querystring = require('querystring');

export const subscribeNewUserToNewsletters = functions.auth.user().onCreate(async (user) => {
    if (!user.email) return;
    if (builtInEnvVariables.runningInEmulator) return;
    if (!envVariables.newsletter.is_prod_server) return;
    await subscribeToList(user.email, envVariables.newsletter.news_newsletter_id)
    await subscribeToList(user.email, envVariables.newsletter.support_newsletter_id)
});

export const unsubscribeDeletedUserFromNewsletters = functions.auth.user().onDelete(async (user) => {
    if (!user.email) return;
    if (builtInEnvVariables.runningInEmulator) return;
    if (!envVariables.newsletter.is_prod_server) return;
    await unsubscribeFromList(user.email, envVariables.newsletter.news_newsletter_id)
    await unsubscribeFromList(user.email, envVariables.newsletter.support_newsletter_id)
});

//https://sendy.co/api
const subscribeToList = async (email: string, list: string) => {
    const endpoint = envVariables.newsletter.sendy_url
    const apiKey = envVariables.newsletter.sendy_api_key
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
    const endpoint = envVariables.newsletter.sendy_url
    const apiKey = envVariables.newsletter.sendy_api_key
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