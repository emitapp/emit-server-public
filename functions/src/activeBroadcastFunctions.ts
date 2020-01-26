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
        const database = admin.database()

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
        const newBroadcastUid = (await database.ref(userBroadcastSection).push()).key
        
        const ownerSnippetSnapshot = await database.ref(`userSnippets/${data.ownerUid}`).once('value');
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
        //private (/private) data (only the server can use)
        //public (/public) data (the owner can use)
        //and responder (/responders) data (which can be a bit large, so is separated on its own
        //to be loaded only when needed)

        const broadcastPublicData = {
            deathTimestamp: data.deathTimestamp, 
            location: data.location,
            autoConfirm: data.autoConfirm,
            ...(data.note ? { note: data.note } : {}),
            totalConfirmations: 0,
            pendingResponses: 0
        }

        const broadcastPrivateData = {
            cancellationTaskPath: "",
            recepientUids: data.recepients
        }

        updates[userBroadcastSection + "/public/" + newBroadcastUid] = broadcastPublicData
        nulledPaths[userBroadcastSection + "/public/" + newBroadcastUid] = null
        updates[userBroadcastSection + "/private/" + newBroadcastUid] = broadcastPrivateData
        nulledPaths[userBroadcastSection + "/private/" + newBroadcastUid] = null
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
        await database.ref().update(updates);
        return {status: standardHttpsData.returnStatuses.OK}
});

/**
 * This function is called automatically (using Cloud Tasks) to delete broadcasts
 */
export const autoDeleteBroadcast =
    functions.https.onRequest(async (req, res) => {
        const database = admin.database()

        const payload = req.body as DeletionTaskPayload
        try {
            await database.ref().update(payload.paths);
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
    const database = admin.database()

    if (!context.auth) {
        throw standardHttpsData.notSignedInError()
    } 

    if (isEmptyObject(data.newStatuses)){
        throw new functions.https.HttpsError(
            'invalid-argument',
            'No new statuses to change');
    }

    const broadcastRecepients = 
    (await database
    .ref(`activeBroadcasts/${data.broadcasterUid}/private/${data.broadcastUid}/recepientUids`)
    .once('value'))
    .val()

    if (broadcastRecepients === null){
        throw new functions.https.HttpsError(
            "failed-precondition",
            'Broadcast doesn\'t exist');
    }

    const autoConfirm = 
    (await database
    .ref(`activeBroadcasts/${data.broadcasterUid}/public/${data.broadcastUid}/autoConfirm`)
    .once('value'))
    .val()


    //Now that we've done all the crtitcal error checks, getting ready to process all the changes
    //simultaneously
    const updates : { [key: string]: responderStatuses } = {}
    const responseChangePromises : Array<Promise<void>> = []

    const confirmCounterRef = database.ref(`/activeBroadcasts/${data.broadcasterUid}/public/${data.broadcastUid}/totalConfirmations`)
    const pendingCounterRef = database.ref(`/activeBroadcasts/${data.broadcasterUid}/public/${data.broadcastUid}/pendingResponses`)
    const deltas = {confirmations: 0, pending: 0}

    const writePromise = async (key: string) => {
        const newStatus = data.newStatuses[key]

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

        //We should also make sure that if the broadcast wasn't auto-confirm
        //then only the broadcaster can set people to confirmed
        if (!autoConfirm && context.auth.uid !== data.broadcasterUid && newStatus === responderStatuses.CONFIRMED){
            throw new functions.https.HttpsError(
                'permission-denied',
                'Only the owner of manual confirm broacasters can confirm responders');
        }

        //Now we're first going to check if this user still exists
        const responderSnippet = (await database
        .ref(`userSnippets/${key}`)
        .once('value'))
        .val()

        if (!responderSnippet){
            throw new functions.https.HttpsError(
                "failed-precondition",
                `Owner snapshot missing - user has probably deleted their account`);
        }
         
        //Then we're going to nake note of thier change in status to change some 
        //counters.
        const responderSnippetPath = `activeBroadcasts/${data.broadcasterUid}/responders/${data.broadcastUid}/${key}`
        const responderResponseSnippet = (await database
        .ref(responderSnippetPath)
        .once('value'))
        .val()

        recordResponseDeltas(
            responderResponseSnippet ? responderResponseSnippet.status : null,
            newStatus,
            deltas)

        //We could have also constructed this using responderResponseSnippet
        //but I used the responderSnippet because it's a good chance to update some 
        //things that the responder might have changed since they responded
        //(like maybe their profile pic URL)
        const newValue = {...responderSnippet, status: newStatus}
        updates[responderSnippetPath] = newValue

        //Also making sure this reflects on the responder's feed
        //If people are being ignored, then only signal "pending" on thier feed
        if (newStatus === responderStatuses.IGNORED){
            updates[`feeds/${key}/${data.broadcastUid}/status`] = responderStatuses.PENDING
        }else{
            updates[`feeds/${key}/${data.broadcastUid}/status`] = newStatus        
        }
    } 

    Object.keys(data.newStatuses).forEach(key => {   
        responseChangePromises.push(writePromise(key))  
    });


    await Promise.all(responseChangePromises)
    await Promise.all([
        pendingCounterRef.transaction(count => count + deltas.pending),
        confirmCounterRef.transaction(count => count + deltas.confirmations)
    ])
    await database.ref().update(updates);
    return {status: standardHttpsData.returnStatuses.OK}
})


/**
 * This is used by setBroadcastResponse to keep track of changes in responses
 * So that it can reflect those changes in some counters
 * @param before The status before the change
 * @param after The status after the chance
 * @param deltaObject The object that is accumulating these delta
 */
//I didn't make this a trigger becase it would cause problems
//(it would me makign changes based off response auto-deletions as well)
const recordResponseDeltas = (before: string, after: string, deltaObject: any) => {

    if (before === after) return;
    
    if (before === responderStatuses.CONFIRMED){
        //Recrement count if we've lost a confirmation
        deltaObject.confirmations--;
    }else if (after === responderStatuses.CONFIRMED){
         //Increment count if we have a new confirmation
        deltaObject.confirmations++;
    }

    if (before === responderStatuses.PENDING){
        deltaObject.pending--;
    }else if (after === responderStatuses.PENDING){
        deltaObject.pending++;
    }
}
