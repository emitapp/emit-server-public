import admin = require('firebase-admin');
import * as functions from 'firebase-functions';
import * as standardHttpsData from '../standardHttpsData'

interface NotificationData {
    receiverToken: string,
    messageObject: admin.messaging.Message
}

/**
 * Sends a notificaion to a device using their specific FCM token
 */
export const _sendSpecificNotification = functions.https.onCall(
    async (data : NotificationData, context) => {

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
