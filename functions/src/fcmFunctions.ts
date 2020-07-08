import * as functions from 'firebase-functions';
import admin = require('firebase-admin');
import { objectDifference, errorReport, handleError, successReport } from './utilities';
import {notificationSettings} from './accountManagementFunctions'


const firestore = admin.firestore();
const logger = functions.logger
const fcmDataRef = firestore.collection("fcmData")
type fcmToken = string;
type tokenDictionary = { [key: string]: string []; }

type notificationReason = "newBroadcast" | "broadcastResponse" | "newFriend" | "friendRequest" | "mandatory" | "newGroup"
export interface notificationType {
    reason: notificationReason
    broadcastSender?: string
}

/**
 * This function should be called whenever a user signs in or gets a new FCM token
 * It updates the FCM token data that's stored in Firestore to ensure that every user
 * it associated with the correct token, and that no user has a token that another user
 * is now using.
 */
export const updateFCMTokenData = functions.https.onCall(
    async (data : fcmToken, context) => {
    try{
        // Checking that the user is authenticated.
        if (!context.auth) {
            throw errorReport("Authentication Error")
        }

        //Make sure the token is non-emoty 
        if (data.length === 0) {
            throw errorReport('Your token in empty');
        }

        //Only one user should be associated with any fcm token at a given time
        //So find any documents that have this token and delete it from them 
        const query = fcmDataRef.where("tokens", "array-contains", data)
        const documents = await query.get();
        const batchDelete = firestore.batch();

        documents.forEach(doc => {
            batchDelete.update(
                fcmDataRef.doc(doc.id), 
                {tokens: admin.firestore.FieldValue.arrayRemove(data)})
        })
        await batchDelete.commit()

        //Now we can associate this token with it's new 'owner'
        const mainDocRef = fcmDataRef.doc(context.auth.uid);
        const mainDoc = await mainDocRef.get();
        if (mainDoc.exists) {
            await mainDocRef.update({tokens: admin.firestore.FieldValue.arrayUnion(data)})
            return successReport()
        }else{
            logger.warn("A User's FCM data can't be found in Firestore!", {uid: context.auth.uid})
            return errorReport("FCM data not in database")
        }
    }catch(err){
        return handleError(err)
    }
});

/**
 * Sends an FCM message to users when they get a new friend request
 */
export const fcmNewFriendRequest = functions.database.ref('/friendRequests/{receiverUid}/inbox/{senderUid}')
.onCreate(async (snapshot, context) => {
    const message : any = {}
    message.data = {}
    message.data.type = 'new_friend_request'
    message.data.title = `${snapshot.val().name} sent you a friend request!`
    message.data.body = "Open Biteup to accept the friend request"
    message.data.senderUid = context.params.senderUid
    message.android = {}
    message.android.priority = "NORMAL"
    await sendFCMMessageToUsers([context.params.receiverUid], message, {reason: 'friendRequest'})
})

/**
 * Sends an FCM message to users when they get a new friend request
 */
export const fcmNewFriend = functions.database.ref('/userFriendGroupings/{receiverUid}/_masterSnippets/{newFriendUid}')
.onCreate(async (snapshot, context) => {
    const message : any = {}
    message.data = {}
    message.data.type = 'new_friend'
    message.data.title = `${snapshot.val().name} is now your friend!`
    message.data.newFriendUid = context.params.newFriendUid
    message.android = {}
    message.android.priority = "NORMAL"
    await sendFCMMessageToUsers([context.params.receiverUid], message, {reason: 'newFriend'})
})

/**
 * Sends an FCM message to users when they get a new active broadcast in their feed
 */
export const fcmNewActiveBroadcast = functions.database.ref('/activeBroadcasts/{broadcasterUid}/private/{broadcastUid}')
.onCreate(async (snapshot, context) => {
    console.log("Imagine this does something!")
})

/**
 * Sends an FCM message to users when they get a new friend request
 */
export const fcmAddedToGroup = functions.database.ref('/userGroups/{groupUid}/memberUids')
.onWrite(async (snapshot, context) => {
    if (!snapshot.after.exists()) return;
    const newMembersUids = [] as string[]
    if (snapshot.before.val()){
        newMembersUids.concat([...objectDifference(snapshot.after.val(), snapshot.before.val())])
    }else{
        newMembersUids.concat(Object.keys(snapshot.after.val()))
    }

    const groupName = (await admin.database()
        .ref(`/userGroups/${context.params.groupUid}/snippet/name`)
        .once("value")).val()

    const message : any = {}
    message.data = {}
    message.data.type = 'new_group'
    message.data.title = `You've been added to the ${groupName} group!`
    message.data.newGroupUid = context.params.groupUid
    message.android = {}
    message.android.priority = "NORMAL"
    await sendFCMMessageToUsers(newMembersUids, message, {reason: 'newGroup'})
})

/**
 * There are a number of configurations that notification objects must have to be seen
 * in forground, background and quit states. This generates a properly configured one.
 * Remember to fill in the tokens later
 * @param expiresIn The notification's TTL in **seconds** (optional)
 */
//Exported for use in testing functions too
//https://rnfirebase.io/messaging/usage#data-only-messages
//https://developer.apple.com/documentation/usernotifications/setting_up_a_remote_notification_server/sending_notification_requests_to_apns/
//https://firebase.google.com/docs/cloud-messaging/concept-options#delivery-options
//https://firebase.google.com/docs/reference/admin/node/admin.messaging.MulticastMessage
export const generateFCMMessageObject = (expiresIn: number | null = null) : admin.messaging.MulticastMessage => {
    const message : admin.messaging.MulticastMessage = {
        data: {}, //The meat of the notification

        tokens: [], //Will be filled later by sendFCMMessageToUsers function

        android:{
            priority:"high" //Gives message priority to be seen in background and quit state
        },
      
        apns: {
            payload: {
                aps: {
                    contentAvailable: true //Gives message priority to be seen in background and quit state
                }
            },
            headers: {
                'apns-push-type': 'background', //Since notifications are handles locally by the client, no need to make this 'alert'
                'apns-priority': '5', //Has to be 5 becuase of contentAvailable, though 10 would be ideal
                'apns-topic': functions.config().env.fcm.app_bundle_id //your app bundle identfier
            }
        }
    }

    if (expiresIn){
        //Useless if statements added because linter complaining about ts(2532) ('Possibly undefined')
        //Typescript is a genius ._.
        if (message.android) message.android.ttl = expiresIn * 1000
        if (message.apns?.headers) message.apns.headers["apns-expiration"] = `${Math.floor(Date.now() / 1000) + expiresIn}`
    }
    return message
}


/**
 * Sends the FCM message to all the target users. Thanks to overengineering (lol),
 * it can work with any number of users.
 * @param userUids The user ids of all the target users
 * @param bareMessage A notification object WITHOUT any recepient data
 */
//Being exported for use in testing functions
export const sendFCMMessageToUsers = async (
    userUids : string[], 
    bareMessage : admin.messaging.MulticastMessage, 
    notifType: notificationType) => {
    try{
        if (userUids.length === 0) return;

        //First, reading all the FCM tokens for each user from Firestore
        const masterTokenDictionary : tokenDictionary = {} 
        const retreivalPromises : Promise<any>[] = []
        const allTokens : fcmToken[] = []
        const tokenRetrievalPromise = async (uid : string) => {
            const tokenArray = await getFCMTokens(uid, notifType)
            if (tokenArray){
                masterTokenDictionary[uid] = tokenArray
                allTokens.push.apply(allTokens, tokenArray)
            } 
        } 
        userUids.forEach(uid => retreivalPromises.push(tokenRetrievalPromise(uid)));
        await Promise.all(retreivalPromises)
    
        //Now splitting the token array into chunks of 500 for sending
        //(since FCM multicasts can send a max of 500 messages per batch)
        //(funnily enough, firestore batch writes can also perform up to 500 writes)
        const tokenArrayChunks = chunkArray(allTokens, 500)
        const multicastPromises : Promise<any>[] = []
        //https://firebase.google.com/docs/cloud-messaging/send-message#admin
        const trivialFcmErrors = ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'] 

        const mulitcastPromise = async (tokens : fcmToken[]) => {
            const copiedMessage : admin.messaging.MulticastMessage = JSON.parse(JSON.stringify(bareMessage))
            copiedMessage.tokens = tokens
            const response = await admin.messaging().sendMulticast(copiedMessage)
            //Remove any tokens that resulted in failure
            if (response.failureCount === 0) return;
            const batchDelete = firestore.batch();
            response.responses.forEach((resp, index) => {
                if (resp.success) return; //Skip this response
                const failedToken = tokens[index]
                const uid = findUidForToken(failedToken, masterTokenDictionary)
                if (!uid) return; //This shold never be the case but I'm doing this for type safety
                //Delete the invalid token from firestore
                batchDelete.update(
                    fcmDataRef.doc(uid), 
                    {tokens: admin.firestore.FieldValue.arrayRemove(failedToken)}
                )   
                //Also take note of the error if it's not trivial:
                if (!trivialFcmErrors.includes(resp.error?.code ?? "")){
                    logger.warn(`FCM error: ${resp.error?.message}`, {fcmToken: failedToken, userUid: uid})
                } 
            })
            await batchDelete.commit()
        }
    
        tokenArrayChunks.forEach(chunk => multicastPromises.push(mulitcastPromise(chunk)));
        await Promise.all(multicastPromises)
    }catch(err){
        //It's not that important, just console log for now
        logger.error(err)
    }
}

/**
 * Gets the array of FCM tokens associated with any user.
 * Returns undefined if no Firebase doc is found or if the tokens array is empty.
 * This function also takes the type of the notification into account, so it'll
 * also return undefined if the user's preferences wont allow that notification type to be sent
 * @param uid The uid of the user 
 */
const getFCMTokens = async (uid : string, notifType: notificationType) : Promise<string [] | undefined> => {
    const document = await fcmDataRef.doc(uid).get()
    if (!document.exists) return undefined
    const data = document.data()
    if (!data) return undefined
    const settings : notificationSettings = data.notificationPrefs;
    if (!settings) return undefined
    const tokenArray = data.tokens
    if (tokenArray.length === 0) return undefined

    //Now let's check the user prefs against the notification types
    if (notifType.reason === 'mandatory') return tokenArray
    if (notifType.reason === 'friendRequest' && settings.onNewFriendRequest) return tokenArray
    if (notifType.reason === 'newFriend' && settings.onNewFriend) return tokenArray
    if (notifType.reason === 'broadcastResponse' && settings.onNewBroadcastResponse) return tokenArray
    if (notifType.reason === 'newBroadcast' && settings.onBroadcastFrom.includes(notifType.broadcastSender || "")) return tokenArray
    if (notifType.reason === 'newGroup' && settings.onAddedToGroup) return tokenArray
    return undefined
}

/**
 * Find the uid associated with a FCM token given a tokenDictionary
 * Returns undefined if it's not found
 */
const findUidForToken = (token : fcmToken, tokenDic : tokenDictionary) : string | undefined => {
    let foundUid : string | undefined = undefined
    for (const uid of Object.keys(tokenDic)) {
        if (tokenDic[uid].includes(token)){
            foundUid = uid
            break
        }    
    }
    return foundUid;
}

/**
 * Creates an array of elements split into groups the length of size.
 * @param array The array to split up
 * @param size The max suze per chunk
 */
//chunkArray(['a', 'b', 'c', 'd'], 3) => [['a', 'b', 'c'], ['d']]
const chunkArray = (array : any[], size : number) : any[] => {
    return array.reduce((arr, item, idx) => {
        return idx % size === 0
          ? [...arr, [item]]
          : [...arr.slice(0, -1), [...arr.slice(-1)[0], item]];
      }, []);
}

export interface FCMRelatedPaths {
    tokenDocumentPath : string,
}

export const getFCMRelatedPaths = async (userUid : string) : Promise<FCMRelatedPaths> => {
    const paths : FCMRelatedPaths = {tokenDocumentPath : `fcmData/${userUid}`}
    return paths
}
