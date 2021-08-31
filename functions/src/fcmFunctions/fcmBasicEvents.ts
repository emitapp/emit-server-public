import * as functions from 'firebase-functions';
import { CompleteRecipientList } from '../flares/privateFlares';
import { objectDifference, truncate } from '../utils/utilities';
import admin = require('firebase-admin');
import * as fcmCore from './fcmCore'
import { DEFAULT_DOMAIN_HASH, getPublicFlareCol, ShortenedPublicFlareInformation } from '../flares/publicFlares'
import { getUsersNearLocation, PUBLIC_FLARE_RADIUS_IN_M } from '../userLocationFunctions';

const database = admin.database();

/**
 * Sends an FCM message to users when they get a new friend request
 */
export const fcmNewFriendRequest = functions.database.ref('/friendRequests/{receiverUid}/inbox/{senderUid}')
    .onCreate(async (snapshot, context) => {
        const message = fcmCore.generateFCMMessageObject()
        message.data.reason = "friendRequest"
        message.notification.title = `${snapshot.val().displayName} sent you a friend request!`
        message.notification.body = "Open Emit to accept the friend request"
        message.data.causerUid = context.params.senderUid
        await fcmCore.sendFCMMessageToUsers([context.params.receiverUid], message)
    })

/**
 * Sends an FCM message to users when they make a new friend
 */
export const fcmNewFriend = functions.database.ref('/userFriendGroupings/{receiverUid}/_masterSnippets/{newFriendUid}')
    .onCreate(async (snapshot, context) => {
        const message = fcmCore.generateFCMMessageObject()
        message.data.reason = "newFriend"
        message.notification.title = `${snapshot.val().displayName} is now your friend!`
        message.data.causerUid = context.params.newFriendUid
        await fcmCore.sendFCMMessageToUsers([context.params.receiverUid], message)
    })

/** 
 * Sends an FCM message to users when they get a new active broadcast in their feed
 */
export const fcmNewActiveBroadcast = functions.database.ref('/activeBroadcasts/{broadcasterUid}/private/{broadcastUid}/recepientUids')
    .onCreate(async (snapshot, context) => {
        const recipientList: CompleteRecipientList = snapshot.val()
        if (!recipientList.direct) recipientList.direct = {}
        if (!recipientList.groups) recipientList.groups = {}

        const fcmPromises: Promise<any>[] = []
        const flareInfo = (await database.ref(`activeBroadcasts/${context.params.broadcasterUid}/public/${context.params.broadcastUid}`).once("value")).val()
        const senderDisplayName = (await database.ref(`/userSnippets/${context.params.broadcasterUid}`)
            .once("value")).val()?.displayName

        const fcmToDirectRecepients = async () => {
            const message = fcmCore.generateFCMMessageObject(600)

            message.data.reason = 'newBroadcast'
            message.notification.title = `${senderDisplayName} made a flare!`
            message.notification.body = `${flareInfo?.emoji} ${flareInfo?.activity}`
            message.data.causerUid = context.params.broadcasterUid
            message.data.associatedFlareId = context.params.broadcastUid
            await fcmCore.sendFCMMessageToUsers(Object.keys(recipientList.direct), message)
        }

        const fcmToGroupRecepients = async (groupName: string, groupUid: string, recepients: string[]) => {
            const message = fcmCore.generateFCMMessageObject(600)
            message.data.reason = 'newBroadcast'
            message.notification.title = `${senderDisplayName} made a flare!`
            message.notification.body = `${flareInfo?.emoji} ${flareInfo?.activity} (via ${groupName} group)`
            message.data.causerUid = context.params.broadcasterUid
            message.data.groupUid = groupUid
            message.data.associatedFlareId = context.params.broadcastUid
            await fcmCore.sendFCMMessageToUsers(recepients, message)
        }

        fcmPromises.push(fcmToDirectRecepients())
        for (const groupUid of Object.keys(recipientList.groups || {})) {
            const group = recipientList.groups[groupUid]
            fcmPromises.push(fcmToGroupRecepients(group.groupName, groupUid, Object.keys(group.members)))
        }
        await Promise.all(fcmPromises)
    })

/**
 * Sends an FCM message to users when they get a new friend request
 */
export const fcmAddedToGroup = functions.database.ref('/userGroups/{groupUid}/memberUids')
    .onWrite(async (snapshot, context) => {
        if (!snapshot.after.exists()) return; //The group was deleted
        let newMembersUids: string[] = []
        if (snapshot.before.val()) {
            newMembersUids = newMembersUids.concat([...objectDifference(snapshot.after.val(), snapshot.before.val())])
        } else {
            newMembersUids = newMembersUids.concat(Object.keys(snapshot.after.val()))
        }

        const groupName = (await admin.database()
            .ref(`/userGroups/${context.params.groupUid}/snippet/name`)
            .once("value")).val()

        const message = fcmCore.generateFCMMessageObject()
        message.data.reason = "newGroup"
        message.notification.title = `You've been added to the ${groupName} group!`
        message.data.causerUid = context.params.groupUid
        await fcmCore.sendFCMMessageToUsers(newMembersUids, message)
    })

/**
 * Send an FCM message to a user when someone responds to one of their private flares
 */
export const fcmBroadcastResponse = functions.database.ref('activeBroadcasts/{broadcasterUid}/responders/{broadcastUid}/{newResponderUid}')
    .onCreate(async (snapshot, context) => {
        const message = fcmCore.generateFCMMessageObject()
        message.data.reason = 'broadcastResponse'
        message.notification.title = `${snapshot.val().displayName} is in!`
        message.data.causerUid = context.params.newResponderUid
        message.data.broadcasterUid = context.params.broadcasterUid
        message.data.associatedFlareId = context.params.broadcastUid
        await fcmCore.sendFCMMessageToUsers([context.params.broadcasterUid], message)
    })

/**
 * Send an FCM message when a chat comes in (for a private flare chat)
 */
export const fcmChatNotification = functions.database.ref('activeBroadcasts/{broadcasterUid}/chats/{eventId}/{messageID}')
    .onCreate(async (snapshot, context) => {
        if (snapshot.val().system) return; //Don't send notifications for system type messages
        const message = fcmCore.generateFCMMessageObject()
        const flareInfo = (await database.ref(`activeBroadcasts/${context.params.broadcasterUid}/public/${context.params.eventId}`).once("value")).val()
        message.data.reason = 'chatMessage'
        message.notification.body = snapshot.val().user.name + ": " + truncate(snapshot.val().text, 100)
        message.notification.title = `Chat in ${flareInfo?.emoji} ${flareInfo?.activity}`
        message.data.causerUid = snapshot.val().user.id
        message.data.associatedFlareId = context.params.eventId
        message.data.broadcasterUid = context.params.broadcasterUid
        const allChatRecepients = (await database.ref(`activeBroadcasts/${context.params.broadcasterUid}/private/${context.params.eventId}/responderUids`).once("value")).val()
        if (!allChatRecepients) return;
        const respondersArray: string[] = [...Object.keys(allChatRecepients), context.params.broadcasterUid]
        respondersArray.splice(respondersArray.indexOf(message.data.causerUid), 1)
        await fcmCore.sendFCMMessageToUsers(respondersArray, message)
    })

/**
* Send an FCM message when a chat comes in (for a private flare chat)
*/
export const fcmPrivateFlareEdited = functions.database.ref('activeBroadcasts/{broadcasterUid}/private/{eventId}/lastEditId')
    .onWrite(async (snapshot, context) => {
        if (!snapshot.after.exists() || !snapshot.before.exists()) return; //Ignore flare creation and deletion
        const message = fcmCore.generateFCMMessageObject()
        const flareInfo = (await database.ref(`activeBroadcasts/${context.params.broadcasterUid}/public/${context.params.eventId}`).once("value")).val()
        message.data.reason = 'privateFlareEdited'
        message.notification.title = `Flare Edited: ${flareInfo?.emoji} ${flareInfo?.activity}`
        message.notification.body = `${flareInfo.owner.displayName} edited their flare.`
        message.data.associatedFlareId = context.params.eventId
        message.data.broadcasterUid = context.params.broadcasterUid
        const allFlareResponders = (await database.ref(`activeBroadcasts/${context.params.broadcasterUid}/private/${context.params.eventId}/responderUids`).once("value")).val()
        if (!allFlareResponders) return;
        const respondersArray: string[] = Object.keys(allFlareResponders)
        await fcmCore.sendFCMMessageToUsers(respondersArray, message)
    })



export const fcmNearbyPublicFlareNotification = functions.firestore.document('shortenedPublicFlares/{orgoHash}/public_flares_short/{flareUid}')
    .onCreate(async (snap, context) => {
        const message = fcmCore.generateFCMMessageObject()
        const flareInfo = snap.data() as ShortenedPublicFlareInformation
        const orgoHash = context.params.orgoHash
        message.data.reason = "nearbyPublicFlare"
        message.notification.title = `Someone made a flare near you!`
        message.notification.body = `${flareInfo?.emoji} ${flareInfo?.activity} \n Made by ${flareInfo?.owner?.displayName}`
        message.data.causerUid = flareInfo?.owner?.uid
        message.data.associatedFlareId = context.params.flareUid
        message.data.broadcasterUid = flareInfo?.owner?.uid

        if (orgoHash != DEFAULT_DOMAIN_HASH) message.notification.body += ` (${flareInfo.domain})`

        const nearbyUserUids = await getUsersNearLocation(flareInfo.geolocation, PUBLIC_FLARE_RADIUS_IN_M, orgoHash)
        const index = nearbyUserUids.indexOf(flareInfo?.owner?.uid);
        if (index > -1) nearbyUserUids.splice(index, 1);
        await fcmCore.sendFCMMessageToUsers(nearbyUserUids, message)
    });


/**
 * Send an FCM message to a user when someone responds to one of their public flares
 */
export const fcmBroadcastResponsePublicFlare = functions.firestore.document("publicFlares/{orgoHash}/public_flares/{flareUid}/responders/{responderUid}")
    .onCreate(async (doc, context) => {
        const message = fcmCore.generateFCMMessageObject()
        message.data.reason = 'publicFlareResponse'
        message.notification.title = `${doc.data().displayName} is in!`
        message.data.causerUid = context.params.newFriendUid
        message.data.broadcasterUid = doc.data().flareOwner
        message.data.associatedFlareId = context.params.flareUid
        await fcmCore.sendFCMMessageToUsers([doc.data().flareOwner], message)
    });

/**
* Send an FCM message when a chat comes in (for a public flare chat)
*/
export const fcmChatNotificationPublicFlare = functions.database.ref('publicFlareChats/{orgoHash}/{flareUid}/{messageID}')
    .onCreate(async (snapshot, context) => {
        //Quick assignments
        if (snapshot.val().system) return; //Don't send notifications for system type messages
        const message = fcmCore.generateFCMMessageObject()
        const { flareUid, orgoHash } = context.params
        const flareInfo = (await getPublicFlareCol(orgoHash).doc(flareUid).get()).data()

        //Composing message
        message.data.reason = 'publicFlareChatMessage'
        message.notification.body = snapshot.val().user.name + ": " + truncate(snapshot.val().text, 100)
        message.notification.title = `Chat in ${flareInfo?.emoji} ${flareInfo?.activity}`
        message.data.causerUid = snapshot.val().user.id
        message.data.associatedFlareId = context.params.flareUid
        message.data.broadcasterUid = flareInfo?.owner.uid
        const allChatRecepients = flareInfo?.responders
        if (!allChatRecepients) return;

        //Sending message
        const respondersArray: string[] = [...Object.keys(allChatRecepients), flareInfo?.owner.uid]
        respondersArray.splice(respondersArray.indexOf(message.data.causerUid), 1)
        await fcmCore.sendFCMMessageToUsers(respondersArray, message)
    })


