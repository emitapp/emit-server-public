import * as functions from 'firebase-functions';
import admin = require('firebase-admin');
import { objectDifference, errorReport, handleError, successReport, truncate } from './utilities';
import { NotificationSettings } from './accountManagementFunctions'
import { CompleteRecepientList } from './activeBroadcastFunctions'

const database = admin.database();
const firestore = admin.firestore();
const logger = functions.logger

const fcmDataRef = firestore.collection("fcmData")
type fcmToken = string;
type tokenDictionary = { [key: string]: string[]; }
type NotificationReason = "newBroadcast" | "broadcastResponse" | "newFriend" | "friendRequest" | "mandatory" | "newGroup" | "unset" | "chatMessage"

export interface MulticastMessagePayload {
    reason: NotificationReason
    [x: string]: string
}

export interface CreatedMulticastMessage extends admin.messaging.MulticastMessage {
    data: MulticastMessagePayload, //Adding additional reqs for "data"
    notification: admin.messaging.Notification //just making "notification" mandatory
}

/**
 * This function should be called whenever a user signs in or gets a new FCM token
 * It updates the FCM token data that's stored in Firestore to ensure that every user
 * it associated with the correct token, and that no user has a token that another user
 * is now using.
 */
export const updateFCMTokenData = functions.https.onCall(
    async (data: fcmToken, context) => {
        try {
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
                    { tokens: admin.firestore.FieldValue.arrayRemove(data) })
            })
            await batchDelete.commit()

            //Now we can associate this token with it's new 'owner'
            const mainDocRef = fcmDataRef.doc(context.auth.uid);
            const mainDoc = await mainDocRef.get();
            if (mainDoc.exists) {
                await mainDocRef.update({ tokens: admin.firestore.FieldValue.arrayUnion(data) })
                return successReport()
            } else {
                logger.warn("A User's FCM data can't be found in Firestore!", { uid: context.auth.uid })
                return errorReport("FCM data not in database")
            }
        } catch (err) {
            return handleError(err)
        }
    });

/**
 * Called when a user logs out to disassociate their fcm token from themselves
 */
//TODO: since this doesnt check for auth, this is a security concern 
export const disassociateToken = functions.https.onCall(
    async (data: fcmToken, _) => {
        try {
            //Make sure the token is non-empty 
            if (data.length === 0) {
                throw errorReport('Your token in empty');
            }

            //Find any documents that have this token and delete it from them 
            const query = fcmDataRef.where("tokens", "array-contains", data)
            const documents = await query.get();
            const batchDelete = firestore.batch();

            documents.forEach(doc => {
                batchDelete.update(
                    fcmDataRef.doc(doc.id),
                    { tokens: admin.firestore.FieldValue.arrayRemove(data) })
            })
            await batchDelete.commit()

        } catch (err) {
            return handleError(err)
        }
    });


/**
 * Sends an FCM message to users when they get a new friend request
 */
export const fcmNewFriendRequest = functions.database.ref('/friendRequests/{receiverUid}/inbox/{senderUid}')
    .onCreate(async (snapshot, context) => {
        const message = generateFCMMessageObject()
        message.data.reason = "friendRequest"
        message.notification.title = `${snapshot.val().displayName} sent you a friend request!`
        message.notification.body = "Open Emit to accept the friend request"
        message.data.causerUid = context.params.senderUid
        await sendFCMMessageToUsers([context.params.receiverUid], message)
    })

/**
 * Sends an FCM message to users when they make a new friend
 */
export const fcmNewFriend = functions.database.ref('/userFriendGroupings/{receiverUid}/_masterSnippets/{newFriendUid}')
    .onCreate(async (snapshot, context) => {
        const message = generateFCMMessageObject()
        message.data.reason = "newFriend"
        message.notification.title = `${snapshot.val().displayName} is now your friend!`
        message.data.causerUid = context.params.newFriendUid
        await sendFCMMessageToUsers([context.params.receiverUid], message)
    })

/**
 * Sends an FCM message to users when they get a new active broadcast in their feed
 */
export const fcmNewActiveBroadcast = functions.database.ref('/activeBroadcasts/{broadcasterUid}/private/{broadcastUid}/recepientUids')
    .onCreate(async (snapshot, context) => {
        const recepientList: CompleteRecepientList = snapshot.val()
        const fcmPromises: Promise<any>[] = []
        const flareInfo = (await database.ref(`activeBroadcasts/${context.params.broadcasterUid}/public/${context.params.broadcastUid}`).once("value")).val()


        const fcmToDirectRecepients = async () => {
            const message = generateFCMMessageObject(600)
            const senderDisplayName = (await database.ref(`/userSnippets/${context.params.broadcasterUid}`)
                .once("value")).val()?.displayName
            message.data.reason = 'newBroadcast'
            message.notification.title = `${senderDisplayName} made a flare!`
            message.notification.body = `${flareInfo?.emoji} ${flareInfo?.activity}`
            message.data.causerUid = context.params.broadcasterUid
            await sendFCMMessageToUsers(Object.keys(recepientList.direct), message)
        }

        const fcmToGroupRecepients = async (groupName: string, recepients: string[]) => {
            const message = generateFCMMessageObject(600)
            message.data.reason = 'newBroadcast'
            message.notification.title = `A member of ${groupName} has made a new flare!`
            message.notification.body = `${flareInfo?.emoji} ${flareInfo?.activity}`
            message.data.causerUid = context.params.broadcasterUid
            await sendFCMMessageToUsers(Object.keys(recepients), message)
        }

        fcmPromises.push(fcmToDirectRecepients())
        for (const group of Object.values(recepientList.groups || {})) {
            fcmPromises.push(fcmToGroupRecepients(group.groupName, Object.keys(group.members)))
        }
        await Promise.all(fcmPromises)
    })

/**
 * Sends an FCM message to users when they get a new friend request
 */
export const fcmAddedToGroup = functions.database.ref('/userGroups/{groupUid}/memberUids')
    .onWrite(async (snapshot, context) => {
        if (!snapshot.after.exists()) return; //The group was deleted
        const newMembersUids: string[] = []
        if (snapshot.before.val()) {
            newMembersUids.concat([...objectDifference(snapshot.after.val(), snapshot.before.val())])
        } else {
            newMembersUids.concat(Object.keys(snapshot.after.val()))
        }

        const groupName = (await admin.database()
            .ref(`/userGroups/${context.params.groupUid}/snippet/name`)
            .once("value")).val()

        const message = generateFCMMessageObject()
        message.data.reason = "newGroup"
        message.notification.title = `You've been added to the ${groupName} group!`
        message.data.causerUid = context.params.groupUid
        await sendFCMMessageToUsers(newMembersUids, message)
    })

/**
 * Send an FCM message to a user when someone responds to one of ther broadcasts
 */
export const fcmBroadcastResponse = functions.database.ref('activeBroadcasts/{broadcasterUid}/responders/{broadcastUid}/{newResponderUid}')
    .onCreate(async (snapshot, context) => {
        const message = generateFCMMessageObject()
        message.data.reason = 'broadcastResponse'
        message.notification.title = `${snapshot.val().displayName} is in!`
        message.data.causerUid = context.params.newFriendUid
        await sendFCMMessageToUsers([context.params.broadcasterUid], message)
    })

/**
 * Send an FCM message when a chat comes in
 */
export const fcmChatNotification = functions.database.ref('activeBroadcasts/{broadcasterUid}/chats/{eventId}/{messageID}')
    .onCreate(async (snapshot, context) => {
        const message = generateFCMMessageObject()
        const flareInfo = (await database.ref(`activeBroadcasts/${context.params.broadcasterUid}/public/${context.params.eventId}`).once("value")).val()
        message.data.reason = 'chatMessage'
        message.notification.body = snapshot.val().user.name + ": " + truncate(snapshot.val().text, 100)
        message.notification.title = `Chat in ${flareInfo?.emoji} ${flareInfo?.activity}`
        message.data.causerUid = snapshot.val().user.id
        message.data.associatedFlareId = context.params.eventId
        const allChatRecepients = (await database.ref(`activeBroadcasts/${context.params.broadcasterUid}/private/${context.params.eventId}/responderUids`).once("value")).val()
        if (!allChatRecepients) return;
        const respondersArray: string[] = [...Object.keys(allChatRecepients), context.params.broadcasterUid]
        respondersArray.splice(respondersArray.indexOf(message.data.causerUid), 1)
        await sendFCMMessageToUsers(respondersArray, message)
    })



/**
 * There are a number of configurations that notification objects must have to be seen
 * in forground, background and quit states. This generates a properly configured one.
 * Remember to fill in the tokens later (usually done by sendFCMMessageToUsers) 
 * and set the notification type deatils.
 * @param expiresIn The notification's TTL in **seconds** (optional)
 */
//Exported for use in testing functions too

//Currently this uses notification+data only messages becuase APNS throttles data-only 
//notifcations too much.
//In case data-only notifications were to be investigated further, some linke below are useful.
//Git history of this repo will also prove useful
//https://rnfirebase.io/messaging/usage#data-only-messages
//https://developer.apple.com/documentation/usernotifications/setting_up_a_remote_notification_server/sending_notification_requests_to_apns/
//https://firebase.google.com/docs/cloud-messaging/concept-options#delivery-options
//https://firebase.google.com/docs/reference/admin/node/admin.messaging.MulticastMessage
//TODO: consider adding support for things like channels (we originally did that when using 
//data-only notifications and using react-native-push-notifications but we can't do that so easily now)
export const generateFCMMessageObject = (expiresIn: number | null = null): CreatedMulticastMessage => {
    const message: CreatedMulticastMessage = {
        //notification and data are filled by the caller
        notification: {
            title: "",
            body: ""
        },

        data: {
            reason: "unset",
            causerUid: "",
        },

        android: {
            
        },

        apns: {
            headers: {
            }, 
            payload: {
                aps: {
                    sound: "default"
                }
            }
        },

        tokens: [], //Will be filled later by sendFCMMessageToUsers function
    }

    if (expiresIn) {
        //Useless if statements added because linter complaining about ts(2532) ('Possibly undefined')
        //Typescript is a genius ._.
        //FIXME: For some reason adding ttl information makes these notifications silent. Find out why
        // if (message.android) message.android.ttl = expiresIn * 1000
        // if (message.apns?.headers) message.apns.headers["apns-expiration"] = `${Math.floor(Date.now() / 1000) + expiresIn}`
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
    userUids: string[],
    bareMessage: CreatedMulticastMessage): Promise<void> => {
    try {
        if (userUids.length === 0) return;
        if (bareMessage.data.reason == 'unset') throw errorReport("Notification Reason Unset")

        //First, reading all the FCM tokens for each user from Firestore
        const masterTokenDictionary: tokenDictionary = {}
        const retreivalPromises: Promise<any>[] = []
        const allTokens: fcmToken[] = []
        const tokenRetrievalPromise = async (uid: string) => {
            const tokenArray = await getFCMTokens(uid, bareMessage)
            if (tokenArray) {
                masterTokenDictionary[uid] = tokenArray
                allTokens.push(...tokenArray)
            }
        }
        userUids.forEach(uid => retreivalPromises.push(tokenRetrievalPromise(uid)));
        await Promise.all(retreivalPromises)

        //Now splitting the token array into chunks of 500 for sending
        //(since FCM multicasts can send a max of 500 messages per batch)
        //(funnily enough, firestore batch writes can also perform up to 500 writes)
        const tokenArrayChunks = chunkArray(allTokens, 500)
        const multicastPromises: Promise<any>[] = []
        //https://firebase.google.com/docs/cloud-messaging/send-message#admin
        const trivialFcmErrors = ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token']

        const mulitcastPromise = async (tokens: fcmToken[]) => {
            const copiedMessage: admin.messaging.MulticastMessage = JSON.parse(JSON.stringify(bareMessage))
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
                    { tokens: admin.firestore.FieldValue.arrayRemove(failedToken) }
                )
                //Also take note of the error if it's not trivial:
                if (!trivialFcmErrors.includes(resp.error?.code ?? "")) {
                    logger.warn(`FCM error: ${resp.error?.message}`, { fcmToken: failedToken, userUid: uid })
                }
            })
            await batchDelete.commit()
        }

        tokenArrayChunks.forEach(chunk => multicastPromises.push(mulitcastPromise(chunk)));
        await Promise.all(multicastPromises)
    } catch (err) {
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
 * @param message The message to be sent
 */
const getFCMTokens = async (uid: string, message: CreatedMulticastMessage): Promise<string[] | undefined> => {
    const document = await fcmDataRef.doc(uid).get()
    if (!document.exists) return undefined
    const data = document.data()
    if (!data) return undefined
    const settings: NotificationSettings = data.notificationPrefs;
    if (!settings) return undefined
    const tokenArray = data.tokens
    if (tokenArray.length === 0) return undefined

    //Now let's check the user prefs against the notification information
    const { reason, causerUid: causalUserUid } = message.data
    if (reason === 'mandatory') return tokenArray
    if (reason === 'friendRequest' && settings.onNewFriendRequest) return tokenArray
    if (reason === 'newFriend' && settings.onNewFriend) return tokenArray
    if (reason === 'broadcastResponse' && settings.onNewBroadcastResponse) return tokenArray
    if (reason === 'newBroadcast' && settings.onBroadcastFrom.includes(causalUserUid)) return tokenArray
    if (reason === 'newGroup' && settings.onAddedToGroup) return tokenArray
    if (reason === 'chatMessage' && settings.onChat) return tokenArray
    return undefined
}

/**
 * Find the uid associated with a FCM token given a tokenDictionary
 * Returns undefined if it's not found
 */
const findUidForToken = (token: fcmToken, tokenDic: tokenDictionary): string | undefined => {
    let foundUid: string | undefined = undefined
    for (const uid of Object.keys(tokenDic)) {
        if (tokenDic[uid].includes(token)) {
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
const chunkArray = (array: any[], size: number): any[] => {
    return array.reduce((arr, item, idx) => {
        return idx % size === 0
            ? [...arr, [item]]
            : [...arr.slice(0, -1), [...arr.slice(-1)[0], item]];
    }, []);
}

export interface FCMRelatedPaths {
    tokenDocumentPath: string,
}

export const getFCMRelatedPaths = async (userUid: string): Promise<FCMRelatedPaths> => {
    const paths: FCMRelatedPaths = { tokenDocumentPath: `fcmData/${userUid}` }
    return paths
}
