import admin = require('firebase-admin');
import * as functions from 'firebase-functions';
import { errorReport, handleError, successReport } from '../../utils/utilities';
import * as defaults from  '../../fcmFunctions/defaults'
import { NotificationSettings } from '../../accountManagementFunctions';
import { builtInEnvVariables } from '../../utils/env/envVariables';

const logger = functions.logger
const firestore = admin.firestore();
const fcmDataRef = firestore.collection("fcmData")

const checkIfEnabled = () => {
    
    if (builtInEnvVariables.runningInEmulator){
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
            const notificationPrefs = doc.data().notificationPrefs as NotificationSettings
            let changeMade = false;
            if (!Array.isArray(notificationPrefs.onBroadcastFrom)){ 
                changeMade = true
                notificationPrefs.onBroadcastFrom = defaults.DEFAULT_FLARE_SUBSCRIPTION_LIST
            }
            if (typeof notificationPrefs.onNewBroadcastResponse != 'boolean') {
                changeMade = true
                notificationPrefs.onNewBroadcastResponse = defaults.DEFUALT_ON_FLARE_RESPONSE_FCM_PREF
            }
            if (typeof notificationPrefs.onNewFriend != 'boolean') {
                changeMade = true
                notificationPrefs.onNewFriend = defaults.DEFUALT_ON_NEW_FRIEND_FCM_PREF
            }
            if (typeof notificationPrefs.onNewFriendRequest != 'boolean') {
                changeMade = true
                notificationPrefs.onNewFriendRequest = defaults.DEFUALT_ON_FRIEND_REQ_FCM_PREF
            }
            if (typeof notificationPrefs.onAddedToGroup != 'boolean') {
                changeMade = true
                notificationPrefs.onAddedToGroup = defaults.DEFUALT_ON_ADDED_GROUP_FCM_PREF
            }
            if (typeof notificationPrefs.onChat != 'boolean') {
                changeMade = true
                notificationPrefs.onChat = defaults.DEFUALT_ON_CHAT_FCM_PREF
            }
            if (typeof notificationPrefs.onNearbyPublicFlare != 'boolean') {
                changeMade = true
                notificationPrefs.onNearbyPublicFlare = defaults.DEFUALT_ON_NEARBY_PUBLIC_FLARE_FCM_PREF
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