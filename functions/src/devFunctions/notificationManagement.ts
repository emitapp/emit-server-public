import admin = require('firebase-admin');
import * as functions from 'firebase-functions';
import { errorReport, handleError, successReport } from '../utilities';

const logger = functions.logger
const firestore = admin.firestore();
const fcmDataRef = firestore.collection("fcmData")

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
//There are loads of ways this could probably be made more scalable, but hey, this was made
//in a rush
export const dev_enforceFCMFirestoreIntegrity = functions.https.onCall(
    async (_, __) => {
    try{
        checkIfEnabled();
        const allFCMDocs = await fcmDataRef.get()
        const promises : Array<Promise<any>> = []

        const checkPromise = async (doc: FirebaseFirestore.QueryDocumentSnapshot<FirebaseFirestore.DocumentData>) => {
            const notificationPrefs = doc.data().notificationPrefs
            let changeMade = false;
            if (!Array.isArray(notificationPrefs.onBroadcastFrom)){ 
                changeMade = true
                notificationPrefs.onBroadcastFrom = []
            }
            if (typeof notificationPrefs.onNewBroadcastResponse != 'boolean') {
                changeMade = true
                notificationPrefs.onNewBroadcastResponse = true
            }
            if (typeof notificationPrefs.onNewFriend != 'boolean') {
                changeMade = true
                notificationPrefs.onNewFriend = true
            }
            if (typeof notificationPrefs.onNewFriendRequest != 'boolean') {
                changeMade = true
                notificationPrefs.onNewFriendRequest = true
            }
            if (typeof notificationPrefs.onAddedToGroup != 'boolean') {
                changeMade = true
                notificationPrefs.onAddedToGroup = true
            }
            if (typeof notificationPrefs.onChat != 'boolean') {
                changeMade = true
                notificationPrefs.onChat = true
            }

            //Make a write of ther's been some changes
            if (changeMade) await doc.ref.set({notificationPrefs, tokens: doc.data().tokens})
        }

        allFCMDocs.forEach(doc => {
            promises.push(checkPromise(doc))
        })

        await Promise.all(promises)
        return successReport()
    }catch(err){
        return handleError(err)
    }
});