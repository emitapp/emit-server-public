import * as functions from 'firebase-functions';
import * as standardHttpsData from './standardHttpsData'
import admin = require('firebase-admin');

type fcmToken = string;
const firestore = admin.firestore();


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
    const fcmTokensRef = firestore.collection("fcmTokenData")
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
