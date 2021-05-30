import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin'
export const FLARE_LIFETIME_CAP_MINS = 2879 //48 hours - 1 minute
export const TASKS_QUEUE = functions.config().env.broadcastCreation.autodelete_task_queue_name
export const MAX_LOCATION_NAME_LENGTH = 100
export const MAX_BROADCAST_NOTE_LENGTH = 500

const makeFlareSlug = (length: number): string => {
    let result = '';
    const characters = 'abcdefghijklmnopqrstuvwxyz';
    const charactersLength = characters.length;
    for (let i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
}

export const getAvailableFlareSlug = async (length: number): Promise<string> => {
    const database = admin.database()
    let slug = ""
    let unique = false
    while (!unique) { //FIXME: Potential point of woes haha. 
        slug = makeFlareSlug(length)
        const uniquenessCheck = await database.ref(`flareSlugs/${slug}`).once("value");
        if (!uniquenessCheck.exists()) unique = true
    }
    return slug
}

