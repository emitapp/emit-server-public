import admin = require('firebase-admin');
import * as functions from 'firebase-functions';
import {successReport, errorReport, handleError} from '../utilities'
import {
    sendFCMMessageToUsers, 
    generateFCMMessageObject, 
    MulticastMessagePayload
} from '../fcmFunctions'

const logger = functions.logger

interface TokenNotificationData {
    receiverToken: string,
    data: MulticastMessagePayload,
    notification: admin.messaging.Notification
}

interface UidNotificationData {
    receiverUids: string[],
    data: MulticastMessagePayload,
    notification: admin.messaging.Notification
}

const checkIfEnabled = () => {
    
    if (process.env.FUNCTIONS_EMULATOR){
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
    try{
        checkIfEnabled();
        const bareMessage = generateFCMMessageObject()
        bareMessage.data = params.data
        bareMessage.notification = params.notification
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
    }catch(err){
        return handleError(err)
    }
});


/**
 * Sends a notificaion to a groups of users using their uids
 */
export const test_sendNotificationViaUid = functions.https.onCall(
    async (params : UidNotificationData, _) => {
    try{
        checkIfEnabled();
        const message  = generateFCMMessageObject()
        message.data = params.data
        message.notification = params.notification
        await sendFCMMessageToUsers(params.receiverUids, message)
        return successReport()    
    }catch(err){
        return handleError(err)
    }
});
