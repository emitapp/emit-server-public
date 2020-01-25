import admin = require('firebase-admin');
import * as functions from 'firebase-functions';
import * as standardHttpsData from '../standardHttpsData'

//Ensure this is false in prod
const TEST_FUNCS_ENABLED = false;

const firestore = admin.firestore();
interface TokenNotificationData {
    receiverToken: string,
    messageObject: admin.messaging.Message
}

interface UidNotificationData {
    receiverUid: string,
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
 * Sends a notificaion to a user using their Uid
 */
export const test_sendNotificationViaUid = functions.https.onCall(
    async (data : UidNotificationData, context) => {
    checkIfEnabled();

    const fcmTokensRef = firestore.collection("fcmTokenData")
    const document = await fcmTokensRef.doc(data.receiverUid).get();
    if (!document.exists){
        console.log("No FCM record")
        return {status: standardHttpsData.returnStatuses.OK} 
    }

    admin.messaging().sendMulticast({...data.messageObject, tokens: document.data()?.tokens})
        .then((response) => {
            console.log(`Successes: ${response.successCount}, Failures: ${response.failureCount}`);
        })
        .catch((error) => {
            console.log('Error sending message:', error);
        });

    return {status: standardHttpsData.returnStatuses.OK} 
});
