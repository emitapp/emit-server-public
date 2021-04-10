import * as functions from 'firebase-functions';
import { CompleteRecepientList } from '../activeBroadcastFunctions';
import { objectDifference, truncate } from '../utils/utilities';
import admin = require('firebase-admin');
import * as fcmCore from './fcmCore'

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
        const recepientList: CompleteRecepientList = snapshot.val()
        if (!recepientList.direct) recepientList.direct = {}
        if (!recepientList.groups) recepientList.groups = {}

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
            await fcmCore.sendFCMMessageToUsers(Object.keys(recepientList.direct), message)
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
        for (const groupUid of Object.keys(recepientList.groups || {})) {
            const group = recepientList.groups[groupUid]
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
 * Send an FCM message to a user when someone responds to one of ther broadcasts
 */
export const fcmBroadcastResponse = functions.database.ref('activeBroadcasts/{broadcasterUid}/responders/{broadcastUid}/{newResponderUid}')
    .onCreate(async (snapshot, context) => {
        const message = fcmCore.generateFCMMessageObject()
        message.data.reason = 'broadcastResponse'
        message.notification.title = `${snapshot.val().displayName} is in!`
        message.data.causerUid = context.params.newFriendUid
        message.data.broadcasterUid = context.params.broadcasterUid
        message.data.associatedFlareId = context.params.broadcastUid
        await fcmCore.sendFCMMessageToUsers([context.params.broadcasterUid], message)
    })

/**
 * Send an FCM message when a chat comes in
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




