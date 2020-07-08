import admin = require('firebase-admin');
import * as functions from 'firebase-functions';
import {successReport, errorReport} from '../utilities'
import {sendFCMMessageToUsers, generateFCMMessageObject, notificationType} from '../fcmFunctions'

//Ensure this is false in prod
const TEST_FUNCS_ENABLED = false;
const logger = functions.logger

interface TokenNotificationData {
    receiverToken: string,
    data: any
}

interface UidNotificationData {
    receiverUids: string[],
    data: any,
    notifType: notificationType
}

const checkIfEnabled = () => {
    
    if (TEST_FUNCS_ENABLED){
        logger.info("__TEST__ function has been called!")
        return;
    } 
    logger.error("Someone attempted to access a test function even though testing is currently disabled.")
    throw errorReport('This function is only available for testing - it is disabled in production.');
}

/**
 * Sends a notificaion to a device using their specific FCM token
 */
export const test_sendNotificationViaToken = functions.https.onCall(
    async (params : TokenNotificationData, _) => {
    checkIfEnabled();
    const bareMessage = generateFCMMessageObject()
    bareMessage.data = params.data
    delete bareMessage.tokens;
    const message : admin.messaging.Message = {...bareMessage, token: params.receiverToken}
    
    admin.messaging().send(message)
        .then((response) => {
            // Response is am fcm messageID string.
            logger.info('__TEST__:Successfully sent message:', response);
        })
        .catch((error) => {
            logger.info('__TEST__: Error sending message:', error);
        });
    return successReport()
});


/**
 * Sends a notificaion to a groups of users using their uids
 */
export const test_sendNotificationViaUid = functions.https.onCall(
    async (params : UidNotificationData, _) => {
    checkIfEnabled();
    const message = generateFCMMessageObject()
    message.data = params.data
    await sendFCMMessageToUsers(params.receiverUids, message, params.notifType)
    return successReport()
});
