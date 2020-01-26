import admin = require('firebase-admin');
import * as functions from 'firebase-functions';
import * as standardHttpsData from '../standardHttpsData'
import {sendFCMMessageToUsers} from '../fcmFunctions'

//Ensure this is false in prod
const TEST_FUNCS_ENABLED = false;

interface TokenNotificationData {
    receiverToken: string,
    messageObject: admin.messaging.Message
}

interface UidNotificationData {
    receiverUids: string[],
    messageObject: admin.messaging.Message
}

const checkIfEnabled = () => {
    if (TEST_FUNCS_ENABLED) return;
    throw new functions.https.HttpsError(
        "unauthenticated",
        'This function is only available for testing - it is disabled in production.');
}

/**
 * Sends a notificaion to a device using their specific FCM token
 */
export const test_sendNotificationViaToken = functions.https.onCall(
    async (data : TokenNotificationData, context) => {
    checkIfEnabled();
    admin.messaging().send({...data.messageObject, token: data.receiverToken})
        .then((response) => {
            // Response is a message ID string.
            console.log('Successfully sent message:', response);
        })
        .catch((error) => {
            console.log('Error sending message:', error);
        });
    return {status: standardHttpsData.returnStatuses.OK} 
});


/**
 * Sends a notificaion to a groups of users using their uids
 */
export const test_sendNotificationViaUid = functions.https.onCall(
    async (data : UidNotificationData, context) => {
    checkIfEnabled();
    await sendFCMMessageToUsers(data.receiverUids, data.messageObject)
    return {status: standardHttpsData.returnStatuses.OK} 
});
