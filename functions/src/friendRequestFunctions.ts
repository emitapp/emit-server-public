//These were the first cloud functions written for Emit
//We've gotten better since this, so if there are painful to work with, sorry!
import * as functions from 'firebase-functions';
import {handleError, successReport, errorReport} from './utils/utilities';
import admin = require('firebase-admin');
import {subscribeToFlareSender, unsubscribeToFlareSender} from './accountManagementFunctions'

const database = admin.database()

export interface friendRequestFuncParams {
    from: string, //The person calling this action
    to: string //The person being affected by this action
    fromInbox?: boolean, //Is this action being called from the inbox?
    subscribeToFlares?: boolean //should "from" subcribe to "to"'s flares?
}

const standardChecks = (
    data : friendRequestFuncParams, 
    context : functions.https.CallableContext) => {
    // Checking that the user is authenticated.
    if (!context.auth) {
        throw errorReport("Authentication Needed")
    }

    //Make sure params are non-empty
    if (data.from.length === 0 || data.to.length === 0) {
        throw errorReport('Either your to or from param is empty.');
    }

    if (context.auth.uid !== data.from){
        throw errorReport('Your auth token doens\'t match');
    }   
}

/**
 * Sends a friend request to another Emit user
 */
export const sendFriendRequest = functions.https.onCall(
    async (data : friendRequestFuncParams, context) => {
    try{
        standardChecks(data, context)

        if (!context.auth || context.auth.uid === data.to){
            throw errorReport('You can\'t send a friend request to yourself!');
        }

        //Check if the to destination exists as a user...
        const fromSnapshot = await database.ref(`userSnippets/${data.from}`).once('value');
        const toSnapshot = await database.ref(`userSnippets/${data.to}`).once('value');
        if (!toSnapshot.exists()) return errorReport("This user doesn't exist")

        const promises: Array<Promise<void>> = []
        const updates = {} as any;
        const timestamp = Date.now()
        updates[`/friendRequests/${data.to}/inbox/${data.from}`] = {timestamp, ...fromSnapshot.val()};
        updates[`/friendRequests/${data.from}/outbox/${data.to}`] = {timestamp, ...toSnapshot.val()};
        promises.push(database.ref().update(updates))

        if (data.subscribeToFlares) promises.push(subscribeToFlareSender(data.from, data.to))
        await Promise.all(promises)
        return successReport()
    }catch(err){
        return handleError(err)
    }
});

/**
 * Cancels a sent friend request
 * can be called from an outbox (ie a sender)or an inbox (ie a receiver)
 */
export const cancelFriendRequest = functions.https.onCall(
    async (data : friendRequestFuncParams, context) => {
    try{
        standardChecks(data, context)

        if (!context.auth || context.auth.uid === data.to){
            throw errorReport('You can\'t send a friend request to yourself!');
        }

        //We don't have to check if the destination exists because
        //it doens't really matter...
        const updates = {} as any;
        if (data.fromInbox){
            updates[`/friendRequests/${data.to}/outbox/${data.from}`] = null;
            updates[`/friendRequests/${data.from}/inbox/${data.to}`] = null;
        }else{
            updates[`/friendRequests/${data.to}/inbox/${data.from}`] = null;
            updates[`/friendRequests/${data.from}/outbox/${data.to}`] = null;
        }
        
        await Promise.all([
            database.ref().update(updates),
            unsubscribeToFlareSender(data.to, data.from),
            unsubscribeToFlareSender(data.from, data.to)
        ])
        return successReport()
    }catch(err){
        return handleError(err)
    }
});


/**
 * Accepts a friend request from another user
 */
export const acceptFriendRequest = functions.https.onCall(
    async (data : friendRequestFuncParams, context) => {
    try{
        standardChecks(data, context)

        if (!context.auth || context.auth.uid === data.to){
            throw errorReport('You cannot do this operation to yourself!');
        }

        const fromSnapshot = await database.ref(`userSnippets/${data.from}`).once('value');
        const toSnapshot = await database.ref(`userSnippets/${data.to}`).once('value');
        const inboxSnapshot = await database.ref(`/friendRequests/${data.from}/inbox/${data.to}`).once('value');

        const promises: Array<Promise<void>> = []
        const updates = {} as any;

        if (!toSnapshot.exists()) return errorReport("This user doesn't exist!")
        if (!inboxSnapshot.exists()) return errorReport("This user never sent you a friend request")

        updates[`/friendRequests/${data.from}/inbox/${data.to}`] = null;
        updates[`/friendRequests/${data.to}/outbox/${data.from}`] = null;
        updates[`/userFriendGroupings/${data.from}/_masterSnippets/${data.to}`] = toSnapshot.val();
        updates[`/userFriendGroupings/${data.to}/_masterSnippets/${data.from}`] = fromSnapshot.val();
        updates[`/userFriendGroupings/${data.from}/_masterUIDs/${data.to}`] = true;
        updates[`/userFriendGroupings/${data.to}/_masterUIDs/${data.from}`] = true;
        promises.push(database.ref().update(updates))

        if (data.subscribeToFlares) promises.push(subscribeToFlareSender(data.from, data.to))
        await Promise.all(promises)
        return successReport()
    }catch(err){
        return handleError(err)
    }
});


export const removeFriend = functions.https.onCall(
    async (data : friendRequestFuncParams, context) => {
    try{
        standardChecks(data, context)
        const updates = {} as any;

        if (!context.auth || context.auth.uid === data.to){
            return errorReport("Token mismatch")
        }

        const friendExists = (await database.ref(`/userFriendGroupings/${data.from}/_masterUIDs/${data.to}`)
            .once("value")).exists()
        if (!friendExists){
            return errorReport("This user was never your friend")
        }

        //First, get all yout friends uids...
        const addAllRelevantPaths = async (friendA:string, friendB:string) => {
            updates[`/userFriendGroupings/${friendA}/_masterUIDs/${friendB}`] = null
            updates[`/userFriendGroupings/${friendA}/_masterSnippets/${friendB}`] = null
            const membershipListSnapshot = await database.ref(`/userFriendGroupings/${friendA}/_friendMaskMemberships/${friendB}`)
                .once("value")
            if (membershipListSnapshot.exists()){
                updates[`/userFriendGroupings/${friendA}/_friendMaskMemberships/${friendB}`] = null
                for (const maskUid in membershipListSnapshot.val()) {
                    updates[`/userFriendGroupings/${friendA}/custom/details/${maskUid}/memberSnippets/${friendB}`] = null
                    updates[`/userFriendGroupings/${friendA}/custom/details/${maskUid}/memberUids/${friendB}`] = null
                }
            }
        } 

        await Promise.all([
            addAllRelevantPaths(data.from, data.to), 
            addAllRelevantPaths(data.to, data.from),
            unsubscribeToFlareSender(data.to, data.from),
            unsubscribeToFlareSender(data.from, data.to)
            ])
        await database.ref().update(updates);
        return successReport();
    }catch(err){
        return handleError(err)
    }
});

export interface FriendshipRelatedPaths {
    friendshipSections : Array<string>,
    snippetsInOthersFriendSections: Array<string>,
    uidsInOthersFriendSections: Array<string>,
    requestMailbox: string //Your inbox and outbox location
    sentFriendRequests: Array<string>, //Your requests in other people's inboxes
    receivedFriendRequests: Array<string> //The friend requests sent to you from (pointing to others outboxes)
}
   //Used for friendship requests and friendship snippets only. NO data realted to masks
  export const getAllFriendshipRelatedPaths = async (userUid : string) : Promise<FriendshipRelatedPaths> => {
    const paths : FriendshipRelatedPaths = {
        friendshipSections : [],
        requestMailbox: "",
        snippetsInOthersFriendSections: [],
        sentFriendRequests: [],
        receivedFriendRequests: [],
        uidsInOthersFriendSections: []
    }
    // 1) Getting the paths that contain information you manage on you frinds
    paths.friendshipSections.push(`/userFriendGroupings/${userUid}/_masterUIDs`)
    paths.friendshipSections.push(`/userFriendGroupings/${userUid}/_masterSnippets`)

    // 2) Doing something similar for friendRequests
    paths.requestMailbox = `/friendRequests/${userUid}`

    // 3) Getting copies of friend requests in peoples inboxes and outboxes...
    const allInboxRequests = (await database.ref(`/friendRequests/${userUid}/inbox`).once("value")).val()
    const allOutboxRequests = (await database.ref(`/friendRequests/${userUid}/outbox`).once("value")).val()
    for (const senderUid in allInboxRequests) {
        paths.receivedFriendRequests.push(`/friendRequests/${senderUid}/outbox/${userUid}`)
    }
    for (const receiverUid in allOutboxRequests) {
        paths.sentFriendRequests.push(`/friendRequests/${receiverUid}/inbox/${userUid}`)
    }
  
    // 4) Getting the paths that point to your information in other people's friendship sections
    const allFriendsUids = (await database.ref(`/userFriendGroupings/${userUid}/_masterUIDs`).once("value")).val()
    for (const friendUid in allFriendsUids) {
        paths.uidsInOthersFriendSections.push(`/userFriendGroupings/${friendUid}/_masterUIDs/${userUid}`)
        paths.snippetsInOthersFriendSections.push(`/userFriendGroupings/${friendUid}/_masterSnippets/${userUid}`)
    }
    return paths
  }