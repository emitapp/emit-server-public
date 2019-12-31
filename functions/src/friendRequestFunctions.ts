import * as functions from 'firebase-functions';
import * as standardStructs from './standardStructs'
import * as standardHttpsData from './standardHttpsData'
import admin = require('firebase-admin');


const standardChecks = (
    data : standardStructs.fromToStruct, 
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
            'Your auth token doens\'t match the from field provided');
    }   
}

/**
 * Sends a friend request to another Biteup user
 */
export const sendFriendRequest = functions.https.onCall(
    (data : standardStructs.fromToStruct, context) => {
    
    standardChecks(data, context)

    if (!context.auth || context.auth.uid === data.to){
        throw new functions.https.HttpsError(
            'invalid-argument',
            'You can\'t send a friend request to yourself!');
    }

    return async () => {
        //Check if the to destination exists as a user...
        const fromSnapshot = await admin.database().ref(`userSnippets/${data.to}`).once('value');
        const toSnapshot = await admin.database().ref(`userSnippets/${data.to}`).once('value');
        if (!toSnapshot.exists()){
            return {status: standardHttpsData.returnStatuses.NOTO}
        }else{
            const updates = {} as any;
            updates[`/friendRequests/${data.to}/inbox/${data.from}`] = fromSnapshot.val();
            updates[`/friendRequests/${data.from}/outbox/${data.to}`] = toSnapshot.val();
            await admin.database().ref().update(updates);
            return {status: standardHttpsData.returnStatuses.OK}
        }
    };     
});


/**
 * Cancels a sent friend request
 * can be called from an outbox (ie a sender)or an inbox (ie a receiver)
 */
export const cancelFriendRequest = functions.https.onCall(
    (data : standardStructs.friendRequestCancelStruct, context) => {
    
    standardChecks(data, context)

    if (!context.auth || context.auth.uid === data.to){
        throw new functions.https.HttpsError(
            'invalid-argument',
            'You can\'t send a friend request to yourself!');
    }

    return async () => {
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
        await admin.database().ref().update(updates);
        return {status: standardHttpsData.returnStatuses.OK}
    };     
});


/**
 * Accepts a friend request from another user
 */
export const acceptFriendRequest = functions.https.onCall(
    (data : standardStructs.fromToStruct, context) => {
    
    standardChecks(data, context)

    if (!context.auth || context.auth.uid === data.to){
        throw new functions.https.HttpsError(
            'invalid-argument',
            'You cannot do this operation to yourself!');
    }

    return async () => {
        const fromSnapshot = await admin.database().ref(`userSnippets/${data.to}`).once('value');
        const toSnapshot = await admin.database().ref(`userSnippets/${data.to}`).once('value');
        const inboxSnapshot = await admin.database().ref(`/friendRequests/${data.from}/inbox/${data.to}`).once('value');

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
            updates[`/userFriendGroupings/${data.from}/all/${data.to}`] = toSnapshot.val();
            updates[`/userFriendGroupings/${data.to}/all/${data.from}`] = fromSnapshot.val();
            response.status = standardHttpsData.returnStatuses.OK
        }

        await admin.database().ref().update(updates);
        return response
        
    };     
});