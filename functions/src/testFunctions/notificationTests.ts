import admin = require('firebase-admin');
import * as functions from 'firebase-functions';
import {successReport, errorReport} from '../utilities'
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
    
    if (TEST_FUNCS_ENABLED){
        console.warn("Testing function has been called!")
        return;
    } 
    console.error("Some testing function is being accessed even though testing is diabled.")
    throw errorReport('This function is only available for testing - it is disabled in production.');
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
    return successReport()
});


/**
 * Sends a notificaion to a groups of users using their uids
 */
export const test_sendNotificationViaUid = functions.https.onCall(
    async (data : UidNotificationData, context) => {
    checkIfEnabled();
    await sendFCMMessageToUsers(data.receiverUids, data.messageObject)
    return successReport()
});
