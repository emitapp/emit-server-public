import * as functions from 'firebase-functions';
import * as standardHttpsData from './standardHttpsData'
import admin = require('firebase-admin');

type fcmToken = string;
type tokenDictionary = { [key: string]: string []; }
const firestore = admin.firestore();
const fcmTokensRef = firestore.collection("fcmTokenData")


/**
 * This function should be called whenever a user signs in or gets a new FCM token
 * It updates the FCM token data that's stored in Firestore to ensure that every user
 * it associated with the correct token, and that no user has a token that another user
 * is now using.
 */
export const updateFCMTokenData = functions.https.onCall(
    async (data : fcmToken, context) => {

     // Checking that the user is authenticated.
     if (!context.auth) {
        throw standardHttpsData.notSignedInError()
    }

    //Make sure the token is non-emoty 
    if (data.length === 0) {
        throw new functions.https.HttpsError(
            'invalid-argument',
            'Your token in empty');
    }

    //Only one user should be associated with any fcm token at a given time
    //So find any documents that have this token and delete it from them 
    const query = fcmTokensRef.where("tokens", "array-contains", data)
    const documents = await query.get();
    const batchDelete = firestore.batch();

    documents.forEach(doc => {
        batchDelete.update(
            fcmTokensRef.doc(doc.id), 
            {tokens: admin.firestore.FieldValue.arrayRemove(data)})
    })
    await batchDelete.commit()

    //Now we can associate this token with it's new 'owner'
    const mainDocRef = fcmTokensRef.doc(context.auth.uid);
    const mainDoc = await mainDocRef.get();
    if (!mainDoc.exists) {
        await mainDocRef.set({tokens: [data]})
    }else{
        await mainDocRef.update({tokens: admin.firestore.FieldValue.arrayUnion(data)})
    }

    return {status: standardHttpsData.returnStatuses.OK}
});

/**
 * Sends the FCM message to all the target users. Thanks to overengineering (lol),
 * it can work with any number of users.
 * @param userUids The user ids of all the target users
 * @param bareMessage A notification object WITHOUT any recepient data
 */
//Being exported for use in testing functions
export const sendFCMMessageToUsers = async (userUids : string[], bareMessage : admin.messaging.Message) => {
    try{
        if (userUids.length === 0) return;

        //First, reading all the FCM tokens for each user from Firestore
        const masterTokenDictionary : tokenDictionary = {} 
        const retreivalPromises : Promise<any>[] = []
        const allTokens : fcmToken[] = []
        const tokenRetrievalPromise = async (uid : string) => {
            const tokenArray = await getFCMTokens(uid)
            if (tokenArray){
                masterTokenDictionary[uid] = tokenArray
                allTokens.push.apply(allTokens, tokenArray)
            } 
        } 
        userUids.forEach(uid => retreivalPromises.push(tokenRetrievalPromise(uid)));
        await Promise.all(retreivalPromises)
    
        //Now splitting the token array into chunks of 500 for sending
        //(since FCM multicasts can send a max of 500 messages per batch)
        const tokenArrayChunks = chunkArray(allTokens, 2)
        const multicastPromises : Promise<any>[] = []
    
        const mulitcastPromise = async (tokens : fcmToken[]) => {
            const response = await admin.messaging().sendMulticast({...bareMessage, tokens: tokens})
            //Remove any tokens that resulted in failure
            if (response.failureCount === 0) return;
            const batchDelete = firestore.batch();
            response.responses.forEach((resp, index) => {
                if (resp.success) return; //Skip this response
                const failedToken = tokens[index]
                const uid = findUidForToken(failedToken, masterTokenDictionary)
                if (!uid) return; //This shold never be the case but I'm doing this for type safety
                batchDelete.update(
                    fcmTokensRef.doc(uid), 
                    {tokens: admin.firestore.FieldValue.arrayRemove(failedToken)})      
                })
            await batchDelete.commit()
        }
    
        tokenArrayChunks.forEach(chunk => multicastPromises.push(mulitcastPromise(chunk)));
        await Promise.all(multicastPromises)
    }catch(err){
        console.error(err)
    }
}

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
    await sendFCMMessageToUsers([context.params.receiverUid], message)
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
    await sendFCMMessageToUsers([context.params.receiverUid], message)
})

/**
 * Sends an FCM message to users when they get a new friend request
 */
export const fcmNewActiveBroadcast = functions.database.ref('/activeBroadcasts/{broadcasterUid}/private/{broadcastUid}')
.onCreate(async (snapshot, context) => {
    console.log("Imagine this does something!")
})

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

/**
 * Gets the array of FCM tokens associated with any user.
 * Returns undefined if no Firebase doc is found or if the tokens array is empty
 * @param uid The uid of the user 
 */
const getFCMTokens = async (uid : string) : Promise<string [] | undefined> => {
    const document = await fcmTokensRef.doc(uid).get();
    if (!document.exists){
        return undefined
    }else{
        const array = document.data()?.tokens
        if (array.length === 0) return undefined
        return array
    }
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
