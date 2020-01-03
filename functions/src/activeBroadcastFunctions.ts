import * as functions from 'firebase-functions';
//@google-cloud/tasks doesn’t yet support import syntax at time of writing
const { CloudTasksClient } = require('@google-cloud/tasks') 
import admin = require('firebase-admin');

import * as standardHttpsData from './standardHttpsData'
import { isEmptyObject } from './standardFunctions';

interface ActiveBroadcast {
    ownerUid: string,
    location: string,
    note?: string,
    deathTimestamp: number,
    cancellationTaskPath?: string
    recepients: { [key: string]: boolean; }
}

interface DeletionTaskPayload {
    paths: { [key: string]: null }
}

const MIN_BROADCAST_WINDOW = 2 //2 minutes
const MAX_BROADCAST_WINDOW = 2879 //48 hours - 1 minute
const TASKS_LOCATION = 'us-central1'
const FUNCTIONS_LOCATION = 'us-central1'
const TASKS_QUEUE = 'broadcast-ttl'
const serviceAccountEmail = 'the-og-lunchme@appspot.gserviceaccount.com';

const standardChecks = (
    data: ActiveBroadcast, 
    context: functions.https.CallableContext) => {
    // Checking that the user is authenticated.
    if (!context.auth) {
        throw standardHttpsData.notSignedInError()
    } 

    if (context.auth.uid !== data.ownerUid){
        throw new functions.https.HttpsError(
            'invalid-argument',
            'Your auth token doens\'t match');
    }   
}

/**
 * This creates an active broadcast for a user, and sets it ttl (time to live)
 */
export const createActiveBroadcast = functions.https.onCall(
    async (data: ActiveBroadcast, context) => {
        standardChecks(data, context)

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
        const newBroadcastParent = `activeBroadcasts/${data.ownerUid}`
        const newBroadcastUid = (await admin.database().ref(newBroadcastParent).push()).key
        const newBroadcastPath = newBroadcastParent + "/" + newBroadcastUid
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
            ...(data.note ? { note: data.note } : {})
        }

        updates[newBroadcastPath] = data
        nulledPaths[newBroadcastParent] = null
        Object.keys(data.recepients).forEach(recepientUid => {
            updates[`feeds/${recepientUid}/${newBroadcastUid}`] = feedBroadcastObject
            nulledPaths[`feeds/${recepientUid}/${newBroadcastUid}`] = null
        });
        

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
        updates[newBroadcastPath].cancellationTaskPath = response.name
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