import * as functions from 'firebase-functions';
//@google-cloud/tasks doesn’t yet support import syntax at time of writing
const { CloudTasksClient } = require('@google-cloud/tasks') 
import admin = require('firebase-admin');

import * as standardHttpsData from './standardHttpsData'
import { isEmptyObject, truncate } from './standardFunctions';

interface BroadcastCreationRequest {
    ownerUid: string,
    location: string,
    note?: string,
    deathTimestamp: number,
    autoConfirm: boolean,
    recepients: { [key: string]: boolean; }
}

interface DeletionTaskPayload {
    paths: { [key: string]: null }
}

interface BroadcastResponseChange {
    broadcasterUid: string,
    broadcastUid: string
    newStatuses: { [key: string]: responderStatuses }
}

enum responderStatuses {
    CONFIRMED = "Confirmed",
    IGNORED = "Ignored",
    PENDING = "Pending"
}

const MIN_BROADCAST_WINDOW = 2 //2 minutes
const MAX_BROADCAST_WINDOW = 2879 //48 hours - 1 minute
const TASKS_LOCATION = 'us-central1'
const FUNCTIONS_LOCATION = 'us-central1'
const TASKS_QUEUE = 'broadcast-ttl'
const serviceAccountEmail = 'the-og-lunchme@appspot.gserviceaccount.com';



/**
 * This creates an active broadcast for a user, and sets it ttl (time to live)
 */
export const createActiveBroadcast = functions.https.onCall(
    async (data: BroadcastCreationRequest, context) => {
        // Checking that the user is authenticated.
        if (!context.auth) {
            throw standardHttpsData.notSignedInError()
        } 

        if (context.auth.uid !== data.ownerUid){
            throw new functions.https.HttpsError(
                'invalid-argument',
                'Your auth token doens\'t match');
        }   

        const lifeTime = (data.deathTimestamp - Date.now()) / (60000)
        if (isNaN(lifeTime) || lifeTime > MAX_BROADCAST_WINDOW || lifeTime < MIN_BROADCAST_WINDOW){
            throw new functions.https.HttpsError(
                'invalid-argument',
                `Your broadcast should die between ${MIN_BROADCAST_WINDOW}`
                + ` and ${MAX_BROADCAST_WINDOW} minutes from now`);
        }

        if (isEmptyObject(data.recepients)){
            throw new functions.https.HttpsError(
                'invalid-argument',
                `Your broadcast has no recepients`);
        }

        //Setting things up for the batch write
        const updates = {} as any;
        const nulledPaths = {} as any; //Needed for the deletion cloud task
        const userBroadcastSection = `activeBroadcasts/${data.ownerUid}`
        const newBroadcastUid = (await admin.database().ref(userBroadcastSection).push()).key
        
        const ownerSnippetSnapshot = await admin.database().ref(`userSnippets/${data.ownerUid}`).once('value');
        if (!ownerSnippetSnapshot.exists()){
            throw new functions.https.HttpsError(
                "failed-precondition",
                `Owner snapshot missing`);
        }

        //Making the object that will actually be in people's feeds
        const feedBroadcastObject = {
            owner: {uid: data.ownerUid, ...ownerSnippetSnapshot.val()},
            deathTimestamp: data.deathTimestamp, 
            location: data.location,
            ...(data.note ? { note: truncate(data.note, 50) } : {})
        }

        Object.keys(data.recepients).forEach(recepientUid => {
            updates[`feeds/${recepientUid}/${newBroadcastUid}`] = feedBroadcastObject
            nulledPaths[`feeds/${recepientUid}/${newBroadcastUid}`] = null
        });

        //Active broadcasts are split into 3 sections
        //private data (only the server can use)
        //public data (the owner can use)
        //and responder data (which can be a bit large, so is separated on its own
        //to be loaded only when needed)

        const broadcastPublicData = {
            deathTimestamp: data.deathTimestamp, 
            location: data.location,
            autoConfirm: data.autoConfirm,
            ...(data.note ? { note: data.note } : {}),
            totalConfirmations: 0,
            unseenResponses: 0
        }

        const broadcastPrivateData = {
            cancellationTaskPath: "",
            recepientUids: data.recepients
        }

        const broadcastResponderData = {}

        updates[userBroadcastSection + "/public/" + newBroadcastUid] = broadcastPublicData
        nulledPaths[userBroadcastSection + "/public/" + newBroadcastUid] = null
        updates[userBroadcastSection + "/private/" + newBroadcastUid] = broadcastPrivateData
        nulledPaths[userBroadcastSection + "/private/" + newBroadcastUid] = null
        updates[userBroadcastSection + "/responders/" + newBroadcastUid] = broadcastResponderData
        nulledPaths[userBroadcastSection + "/responders/" + newBroadcastUid] = null


        //Setting things up for the Cloud Task that will delete this broadcast after its ttl
        const project = JSON.parse(process.env.FIREBASE_CONFIG!).projectId
        const tasksClient = new CloudTasksClient()
        //queuePath is going to be a string that is the full path of the queue .
        const queuePath: string = tasksClient.queuePath(project, TASKS_LOCATION, TASKS_QUEUE)

        const deletionFuncUrl = `https://${FUNCTIONS_LOCATION}-${project}.cloudfunctions.net/autoDeleteBroadcast`

        const payload: DeletionTaskPayload = { paths: nulledPaths}

        //Now making the task itself
        const task = {
            httpRequest: {
              httpMethod: 'POST',
              url: deletionFuncUrl,
              oidcToken: {
                serviceAccountEmail,
              },          
              //Encoding to base64 is required by the Cloud Tasks API. 
              body: Buffer.from(JSON.stringify(payload)).toString('base64'),
              headers: {
                'Content-Type': 'application/json',
              },
            },
            scheduleTime: {
              seconds: data.deathTimestamp / 1000 //in epoch seconds
            }
        }

        //Finally actaully enqueueing the deletion task
        const [ response ] = await tasksClient.createTask({ parent: queuePath, task })

        //And lastly, doing the batch writes
        //First giving the main broadcast it's deletion task's id
        updates[userBroadcastSection + "/private/" + newBroadcastUid].cancellationTaskPath = response.name
        await admin.database().ref().update(updates);
        return {status: standardHttpsData.returnStatuses.OK}
});

/**
 * This function is called automatically (using Cloud Tasks) to delete broadcasts
 */
export const autoDeleteBroadcast =
    functions.https.onRequest(async (req, res) => {
        const payload = req.body as DeletionTaskPayload
        try {
            await admin.database().ref().update(payload.paths);
            res.send(200)
        }
        catch (error) {
            console.error(error)
            res.status(500).send(error)
        }
})

/**
 * This is called to change or set the response of a user 
 * to a broadcast in their feed
 */
export const setBroadcastResponse = functions.https.onCall(
    async (data: BroadcastResponseChange, context) => {
    if (!context.auth) {
        throw standardHttpsData.notSignedInError()
    } 

    if (isEmptyObject(data.newStatuses)){
        throw new functions.https.HttpsError(
            'invalid-argument',
            'No new statuses to change');
    }

    const broadcastRecepients = 
    (await admin.database()
    .ref(`activeBroadcasts/${data.broadcasterUid}/private/${data.broadcastUid}/recepientUids`)
    .once('value'))
    .val()

    if (broadcastRecepients === null){
        throw new functions.https.HttpsError(
            "failed-precondition",
            'Broadcast doesn\'t exist');
    }

    const updates : { [key: string]: responderStatuses } = {}
    const promises : Array<Promise<void>> = []
    const writePromise = async (key: string) => {
        if (!broadcastRecepients[key]){
            throw new functions.https.HttpsError(
                "failed-precondition",
                'Responder was never a recepient');
        }

        if (!context.auth 
            || (context.auth.uid !== data.broadcasterUid && context.auth.uid !== key)){
            throw new functions.https.HttpsError(
                'permission-denied',
                'You don\'t have the the permission to chnage this user\'s status');
        }
        
        const responderSnippet = (await admin.database()
        .ref(`userSnippets/${key}`)
        .once('value'))
        .val()

        if (!responderSnippet){
            throw new functions.https.HttpsError(
                "failed-precondition",
                `Owner snapshot missing - user has probably deleted their account`);
        } 
        
        const newValue = {...responderSnippet, status: data.newStatuses[key]}
        updates[`activeBroadcasts/${data.broadcasterUid}/responders/${data.broadcastUid}/${key}`] = newValue
    } 

    Object.keys(data.newStatuses).forEach(key => {   
        promises.push(writePromise(key))  
    });

    await Promise.all(promises)
    await admin.database().ref().update(updates);
    return {status: standardHttpsData.returnStatuses.OK}
})


export const onResponderWrite = functions.database
.ref("/activeBroadcasts/{ownerUid}/responders/{broadcastUid}/{responderUid}/status")
.onWrite(async (snapshot, context) => {
    const dataBefore = snapshot.before.val()
    const dataAfter = snapshot.after.val()
    const counterPath = `/activeBroadcasts/${context.params.ownerUid}/public/${context.params.broadcastUid}/totalConfirmations`
    const counterRef = admin.database().ref(counterPath)

    if (dataAfter === dataBefore) return null;
    else{
        //Increment the "unseen changes" counter
        await counterRef.parent?.child("unseenResponses").transaction(count => {
            return count + 1;
        })
    }

    //Recrement count if we've lost a confirmation
    if (dataBefore === responderStatuses.CONFIRMED 
        && dataAfter !== responderStatuses.CONFIRMED){
        return counterRef.transaction(count => {
            return count - 1;
        })
    }

    //Increment count if we have a new confirmation
    if (dataBefore !== responderStatuses.CONFIRMED 
        && dataAfter === responderStatuses.CONFIRMED){
        return counterRef.transaction(count => {
            return count + 1;
        })
    }

    return null;
})
