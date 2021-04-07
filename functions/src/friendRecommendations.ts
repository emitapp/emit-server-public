/**
 * General assumption in this system is that user recommendations are symmetric.
 * So, the recommendation graph in undirected and the weight for A->B = weight for B->A
 */

/**
 * Generally, this module handles the creation and deletion of docs that
 * keep track of "recommendation scores" for pairs of users.
 * At the moment these scores are just influenced by mutual friends
 * 
 * the structure of these docs (assume for users A and B being recommended):
 * doc name: {A's uid}&&{B's uid}, assuming A's uid is alphabecally before B's
 * doc structure:{
 *  score: number
 *  mutualFriends: list of uids
 *  uids: list containing A's and B's uid
 * }
 */

import * as functions from 'firebase-functions';
import admin = require('firebase-admin');

const database = admin.database()
const firestore = admin.firestore()
const logger = functions.logger

const recPathName = "friendRecommendations"

const recDocName = (user1Uid: string, user2Uid: string) => {
    const first = user1Uid > user2Uid ? user1Uid : user2Uid
    const second = first == user1Uid ? user2Uid : user1Uid
    return first + "&&" + second
}

const getUidsFromRecName = (recName: string) => {
    return recName.split("&&")
}

export const updateMutualFriendsOnNewFriend = functions.database.ref('/userFriendGroupings/{receiverUid}/_masterSnippets/{newFriendUid}')
    .onCreate(async (_, context) => {

        const { newFriendUid, receiverUid } = context.params
        const oldFriends = (await database.ref(`/userFriendGroupings/${receiverUid}/_masterSnippets/`).once("value")).val()
        delete oldFriends[newFriendUid]
        const newFriendsFriends = await (await database.ref(`/userFriendGroupings/${newFriendUid}/_masterSnippets/`).once("value")).val()

        const recommendationPromise = async (oldFriendUid: string) => {
            if (newFriendsFriends[oldFriendUid]) return; //They're already friends so no need to recommend them...

            //Otherwise let's add some data to the recommended friend doc...
            const ref = firestore
                .collection(recPathName)
                .doc(recDocName(oldFriendUid, newFriendUid))

            ref.set({
                mutualFriends: admin.firestore.FieldValue.arrayUnion(receiverUid),
                lastUpdate: Date.now()
            }, { merge: true })
        }

        const promises: Array<Promise<any>> = []
        Object.keys(oldFriends).forEach(oldFriend => promises.push(recommendationPromise(oldFriend)));
        const results = await Promise.allSettled(promises)

        for (let i = 0; i < results.length; i++) {
            const status = results[i].status;
            if (status == "fulfilled") continue;
            let message = `Error when adding ${receiverUid} as a mutual friend of ${newFriendUid} and ${Object.keys(oldFriends)[i]}`
            message += (results[i] as PromiseRejectedResult).reason
            logger.error(message)
        }
    })



export const updateMutualFriendsOnFriendRemoval = functions.database.ref('/userFriendGroupings/{receiverUid}/_masterSnippets/{removedFriend}')
    .onDelete(async (_, context) => {

        const { removedFriend, receiverUid } = context.params
        const existingFriends = (await database.ref(`/userFriendGroupings/${receiverUid}/_masterSnippets/`).once("value")).val()
        if (!existingFriends) return;

        delete existingFriends[removedFriend]
        const formerFriendsFriends = await (await database.ref(`/userFriendGroupings/${removedFriend}/_masterSnippets/`).once("value")).val()

        const removalPromisee = async (existingFriendUid: string) => {
            //They're already friends so no need to chaneg this edge in the graph them...
            if (formerFriendsFriends && formerFriendsFriends[existingFriendUid]) return;

            //Otherwise let's remove some data to the recommended friend doc...
            const ref = firestore
                .collection(recPathName)
                .doc(recDocName(existingFriendUid, removedFriend))

            if (!(await ref.get()).exists) return;

            ref.set({
                mutualFriends: admin.firestore.FieldValue.arrayRemove(receiverUid),
                lastUpdate: Date.now()
            }, { merge: true })
        }

        const promises: Array<Promise<any>> = []
        Object.keys(existingFriends).forEach(oldFriend => promises.push(removalPromisee(oldFriend)));
        const results = await Promise.allSettled(promises)

        for (let i = 0; i < results.length; i++) {
            const status = results[i].status;
            if (status == "fulfilled") continue;
            let message = `Error when removing ${receiverUid} as a mutual friend of ${removedFriend} and ${Object.keys(existingFriends)[i]}`
            message += (results[i] as PromiseRejectedResult).reason
            logger.error(message)
        }
    })



export const removeMutualFriendsDocUponNewFriend = functions.database.ref('/userFriendGroupings/{receiverUid}/_masterSnippets/{newFriendUid}')
    .onCreate(async (_, context) => {
        const { newFriendUid, receiverUid } = context.params
        const ref = firestore
            .collection(recPathName)
            .doc(recDocName(receiverUid, newFriendUid))
        await ref.delete()
    })



export const setupRecDoc = functions.firestore.document(`${recPathName}/{docName}`)
    .onCreate((snap, context) => {
        return snap.ref.set({
            uids: getUidsFromRecName(context.params.docName),
            lastUpdate: Date.now() //To trigger updateRecDocScore
        }, { merge: true });
    });


export const updateRecDocScore = functions.firestore.document(`${recPathName}/{docName}`)
    .onUpdate((change, _) => {
        const data = change.after.data();
        const previousData = change.before.data();

        //Preventing update loop
        if (data.lastUpdate == previousData.lastUpdate) {
            return null;
        }

        if (!data.mutualFriends) return null;

        return change.after.ref.set({
            score: data.mutualFriends.length
        }, { merge: true });
    });

export const queryRecDocsRelatedToUser = (uid: string): FirebaseFirestore.Query<FirebaseFirestore.DocumentData> => {
    const ref = firestore
        .collection(recPathName)
        .where("uids", "array-contains", uid)
    return ref;
}

export const queryRecDocsContainingUser = (uid: string): FirebaseFirestore.Query<FirebaseFirestore.DocumentData> => {
    const ref = firestore
        .collection(recPathName)
        .where("mutualFriends", "array-contains", uid)
    return ref;
}