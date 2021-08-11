import * as functions from 'firebase-functions';
import admin = require('firebase-admin');
import * as fcmCore from './fcmCore'
import { enqueueTask } from '../utils/cloudTasks'
import { envVariables } from '../utils/env/envVariables';

const database = admin.database();
const logger = functions.logger

const TASKS_QUEUE = envVariables.broadcastCreation.fcm_task_queue_name

interface OnboardingNotificationPayload {
    recepient: string,
    message: fcmCore.CreatedMulticastMessage
}

export const scheduleOnboardingReminder = functions.auth.user().onCreate(async (user) => {
    const message = fcmCore.generateFCMMessageObject()
    message.data.reason = 'onboardingReminder'
    message.notification.title = `Get more out of Emit. 🔥`
    message.notification.body = "You haven't added that many friends yet! Add some, and consider adding your phone number for better friend recommendations!"

    const timeToSend = Date.now() + 432000000 //5 days from now
    const payload: OnboardingNotificationPayload = { recepient: user.uid, message }
    await enqueueTask(TASKS_QUEUE, "sendOnboardingReminder", payload, timeToSend)
});


export const sendOnboardingReminder =
    functions.https.onRequest(async (req, res) => {
        const payload = req.body as OnboardingNotificationPayload
        try {
            //First get all their friends...
            const friendsSnapshot = await database.ref(`userFriendGroupings/${payload.recepient}/_masterUIDs`).once("value")

            //Send if they have less than 5 friends
            if (!friendsSnapshot.exists() || Object.keys(friendsSnapshot.val()).length < 5) {
                await fcmCore.sendFCMMessageToUsers([payload.recepient], payload.message)
            }
            res.sendStatus(200)
        }
        catch (error) {
            logger.error("sendScheduledNotification error", error)
            res.status(500).send(error)
        }
    })




