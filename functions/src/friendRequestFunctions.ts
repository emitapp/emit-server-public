import * as functions from 'firebase-functions';
import * as standardHttpsData from './standardHttpsData'
import admin = require('firebase-admin');

const database = admin.database()

export interface fromToStruct {
    from: string,
    to: string
}

interface friendRequestCancelStruct extends fromToStruct {
    fromInbox: boolean
}

const standardChecks = (
    data : fromToStruct, 
    context : functions.https.CallableContext) => {
    // Checking that the user is authenticated.
    if (!context.auth) {
        throw standardHttpsData.notSignedInError()
    }

    //Make sure params are non-empty
    if (data.from.length === 0 || data.to.length === 0) {
        throw new functions.https.HttpsError(
            'invalid-argument',
            'Either your to or from param is empty.');
    }

    if (context.auth.uid !== data.from){
        throw new functions.https.HttpsError(
            'invalid-argument',
            'Your auth token doens\'t match');
    }   
}

/**
 * Sends a friend request to another Biteup user
 */
export const sendFriendRequest = functions.https.onCall(
    async (data : fromToStruct, context) => {
    
    standardChecks(data, context)

    if (!context.auth || context.auth.uid === data.to){
        throw new functions.https.HttpsError(
            'invalid-argument',
            'You can\'t send a friend request to yourself!');
    }

    //Check if the to destination exists as a user...
    const fromSnapshot = await database.ref(`userSnippets/${data.from}`).once('value');
    const toSnapshot = await database.ref(`userSnippets/${data.to}`).once('value');
    if (!toSnapshot.exists()){
        return {status: standardHttpsData.returnStatuses.NOTO}
    }else{
        const updates = {} as any;
        const timestamp = Date.now()
        updates[`/friendRequests/${data.to}/inbox/${data.from}`] = {timestamp, ...fromSnapshot.val()};
        updates[`/friendRequests/${data.from}/outbox/${data.to}`] = {timestamp, ...toSnapshot.val()};
        await database.ref().update(updates);
        return {status: standardHttpsData.returnStatuses.OK}
    }
});

/**
 * Cancels a sent friend request
 * can be called from an outbox (ie a sender)or an inbox (ie a receiver)
 */
export const cancelFriendRequest = functions.https.onCall(
    async (data : friendRequestCancelStruct, context) => {
    
    standardChecks(data, context)

    if (!context.auth || context.auth.uid === data.to){
        throw new functions.https.HttpsError(
            'invalid-argument',
            'You can\'t send a friend request to yourself!');
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
    await database.ref().update(updates);
    return {status: standardHttpsData.returnStatuses.OK}
 
});


/**
 * Accepts a friend request from another user
 */
export const acceptFriendRequest = functions.https.onCall(
    async (data : fromToStruct, context) => {
    
    standardChecks(data, context)

    if (!context.auth || context.auth.uid === data.to){
        throw new functions.https.HttpsError(
            'invalid-argument',
            'You cannot do this operation to yourself!');
    }

    const fromSnapshot = await database.ref(`userSnippets/${data.from}`).once('value');
    const toSnapshot = await database.ref(`userSnippets/${data.to}`).once('value');
    const inboxSnapshot = await database.ref(`/friendRequests/${data.from}/inbox/${data.to}`).once('value');

    const updates = {} as any;
    const response = {} as any
    updates[`/friendRequests/${data.from}/inbox/${data.to}`] = null;
    updates[`/friendRequests/${data.to}/outbox/${data.from}`] = null;

    //If the desintation doesn't exist, then let's just erase this friend request
    if (!toSnapshot.exists()){
        response.status = standardHttpsData.returnStatuses.NOTO
    }else if (!inboxSnapshot.exists()){ 
        //This user is trying to accept a request that was never sent to them
        response.status = standardHttpsData.returnStatuses.INVALID
    }else{
        updates[`/userFriendGroupings/${data.from}/_masterSnippets/${data.to}`] = toSnapshot.val();
        updates[`/userFriendGroupings/${data.to}/_masterSnippets/${data.from}`] = fromSnapshot.val();
        updates[`/userFriendGroupings/${data.from}/_masterUIDs/${data.to}`] = true;
        updates[`/userFriendGroupings/${data.to}/_masterUIDs/${data.from}`] = true;
        response.status = standardHttpsData.returnStatuses.OK
    }

    await database.ref().update(updates);
    return response
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
    const allInboxRequests = (await database.ref(`/friendRequests/${userUid}/inbox`).once("value")).val
    const allOutboxRequests = (await database.ref(`/friendRequests/${userUid}/outbox`).once("value")).val
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