import * as functions from 'firebase-functions';
//@google-cloud/tasks doesn’t yet support import syntax at time of writing
const { CloudTasksClient } = require('@google-cloud/tasks') 
import admin = require('firebase-admin');
import * as standardHttpsData from './standardHttpsData'
import { isEmptyObject, truncate } from './standardFunctions';

export const MAX_LOCATION_NAME_LENGTH = 100
export const MAX_BROADCAST_NOTE_LENGTH = 500

interface BroadcastCreationRequest {
    ownerUid: string,
    location: string,
    deathTimestamp: number,
    timeStampRelative: boolean, //Eg: In 5 minutes vs at 12:35am

    geolocation?: {latitude: number, longitude: number},
    note?: string,

    autoConfirm: boolean,
    allFriends: boolean,
    maxResponders?: number,
    friendRecepients: { [key: string]: boolean; },
    maskRecepients: { [key: string]: boolean; },
    groupRecepients: { [key: string]: boolean; }
}

interface DeletionTaskPayload {
    paths: { [key: string]: null }
}

interface CompleteRecepientList {
    direct: { [key: string]: boolean; },
    groups: {[key: string]: RecepientGroupInfo}
}

interface RecepientGroupInfo {
    groupName: string,
    members: { [key: string]: boolean; }
}

interface BroadcastResponseChange {
    broadcasterUid: string,
    broadcastUid: string
    newStatuses: { [key: string]: responderStatuses }
}

enum responderStatuses {
    CONFIRMED = "Confirmed", //Note that this value is also mentioned in the security rules
    IGNORED = "Ignored",
    PENDING = "Pending"
}

const MIN_BROADCAST_WINDOW = 2 //2 minutes
const MAX_BROADCAST_WINDOW = 2879 //48 hours - 1 minute
const TASKS_LOCATION = functions.config().env.broadcastCreation.tasks_location
const FUNCTIONS_LOCATION = functions.config().env.broadcastCreation.functions_location
const TASKS_QUEUE = functions.config().env.broadcastCreation.autodelete_task_queue_name
const serviceAccountEmail = functions.config().env.broadcastCreation.service_account_email;

const database = admin.database()

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

        let lifeTime = 0; //In minutes
        if (data.timeStampRelative){
            lifeTime = data.deathTimestamp / 60000
            data.deathTimestamp += Date.now() //Now making it absolute
        }else{
            lifeTime = (data.deathTimestamp - Date.now()) / (60000)
        }
        if (isNaN(lifeTime) || lifeTime > MAX_BROADCAST_WINDOW || lifeTime < MIN_BROADCAST_WINDOW){
            throw new functions.https.HttpsError(
                'invalid-argument',
                `Your broadcast should die between ${MIN_BROADCAST_WINDOW}`
                + ` and ${MAX_BROADCAST_WINDOW} minutes from now`);
        }

        if (data.maxResponders && !Number.isInteger(data.maxResponders)){
            throw new functions.https.HttpsError(
                'invalid-argument', "Invalid responder cap");
        }

        if (!data.allFriends 
            && isEmptyObject(data.friendRecepients) 
            && isEmptyObject(data.maskRecepients) 
            && isEmptyObject(data.groupRecepients)){
            throw new functions.https.HttpsError(
                'invalid-argument',
                `Your broadcast has no recepients!`);
        }

        if (data.note && data.note.length > MAX_BROADCAST_NOTE_LENGTH){
            throw new functions.https.HttpsError(
                'invalid-argument',
                `Broadcast note too long`);
        }

        if (data.location.length > MAX_LOCATION_NAME_LENGTH){
            throw new functions.https.HttpsError(
                'invalid-argument',
                `Broadcast location name too long`);
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
                `Owner snapshot missing - your account isn't set up yet`);
        }

        //Making the object that will actually be in people's feeds
        const feedBroadcastObject : any = {
            owner: {uid: data.ownerUid, ...ownerSnippetSnapshot.val()},
            deathTimestamp: data.deathTimestamp, 
            location: data.location,
            ...(data.note ? { note: truncate(data.note, 50) } : {})
        }
        if (data.geolocation) feedBroadcastObject.geolocation = data.geolocation

        const allRecepients = await generateRecepientObject(data, context.auth.uid)

        //The way we're doing this, broadcasts sent via groups will overwrite
        //broadcasts sent via direct uids or masks (if someone got a broadcast via both)
        for (const friendUid in allRecepients.direct) {
            updates[`feeds/${friendUid}/${newBroadcastUid}`] = feedBroadcastObject
            nulledPaths[`feeds/${friendUid}/${newBroadcastUid}`] = null
        }
        for (const groupUid in allRecepients.groups) {
            const groupInfo = {name: allRecepients.groups[groupUid].groupName, uid: groupUid}
            for (const memberUid in allRecepients.groups[groupUid].members) {
                updates[`feeds/${memberUid}/${newBroadcastUid}`] = {...feedBroadcastObject, groupInfo}
                nulledPaths[`feeds/${memberUid}/${newBroadcastUid}`] = null
            }
        }

        //Active broadcasts are split into 3 sections
        //private (/private) data (only the server should really read and write)
        //public (/public) data (the owner can write, everyone can read)
        //and responder (/responders) data (which can be a bit large, which is 
        //why it is its own section to be loaded only when needed)

        const broadcastPublicData = {
            deathTimestamp: data.deathTimestamp, 
            location: data.location,
            ...(data.geolocation ? { geolocation: data.geolocation } : {}),
            autoConfirm: data.autoConfirm,
            ...(data.note ? { note: data.note } : {}),
            totalConfirmations: 0,
            pendingResponses: 0
        }

        const broadcastPrivateData = {
            cancellationTaskPath: "",
            recepientUids: allRecepients,
            totalResponses: 0,
            responseCap: data.maxResponders || null
        }

        updates[userBroadcastSection + "/public/" + newBroadcastUid] = broadcastPublicData
        nulledPaths[userBroadcastSection + "/public/" + newBroadcastUid] = null
        updates[userBroadcastSection + "/private/" + newBroadcastUid] = broadcastPrivateData
        nulledPaths[userBroadcastSection + "/private/" + newBroadcastUid] = null
        //responders section starts off empty
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

        const payload = req.body as DeletionTaskPayload
        try {
            await database.ref().update(payload.paths);
            res.sendStatus(200)
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

        if (!isRealRecepient(broadcastRecepients, key)){
            throw new functions.https.HttpsError(
                "failed-precondition",
                'Responder was never a recepient');
        }

        if (!context.auth 
            || (context.auth.uid !== data.broadcasterUid && context.auth.uid !== key)){
            throw new functions.https.HttpsError(
                'permission-denied',
                'You don\'t have the the permission to change this user\'s status');
        }

        //We should also make sure that if the broadcast wasn't auto-confirm
        //then only the broadcaster can set people to confirmed
        if (!autoConfirm && context.auth.uid !== data.broadcasterUid && newStatus === responderStatuses.CONFIRMED){
            throw new functions.https.HttpsError(
                'permission-denied',
                'Only the owner of manual confirm broacasts can confirm responders');
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
        //but I used the responderSnippet because there's chance to update some 
        //things that the responder might have changed since they responded
        //(like maybe their display name).
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

export const lockBroadcastIfNeeded = functions.database.ref('activeBroadcasts/{broadcasterUid}/responders/{broadcastUid}/{newResponderUid}')
.onCreate(async (_, context) => {

    const {broadcasterUid, broadcastUid, newResponderUid} = context.params
    const updates = {} as any
    updates[`/activeBroadcasts/${broadcasterUid}/private/${broadcastUid}/responderUids/${newResponderUid}`] = true

    const totalResponseCountRef = database.ref(`/activeBroadcasts/${broadcasterUid}/private/${broadcastUid}/totalResponses`)
    let totalCount = 0
    await totalResponseCountRef.transaction(count => {
        totalCount = count + 1
        return totalCount
    });

    const responseCapRef = database.ref(`/activeBroadcasts/${broadcasterUid}/private/${broadcastUid}/responseCap`)
    const responseCap = (await responseCapRef.once("value")).val()

    if (responseCap && totalCount >= responseCap){ //Time to lock down the broadcast. Delete it from every non-responder's feed
        const responderUidsRef = database.ref(`/activeBroadcasts/${broadcasterUid}/private/${broadcastUid}/responderUids`)
        const responderUids = {...(await responderUidsRef.once("value")).val()}
        responderUids[newResponderUid] = true //Adding this new responder to the calulcation (since he isn't in the server's record yet)
        const broadcastRecepients : CompleteRecepientList = (await database
            .ref(`activeBroadcasts/${broadcasterUid}/private/${broadcastUid}/recepientUids`)
            .once('value'))
            .val()

        for (const uid of Object.keys(broadcastRecepients.direct || {})) {
            if (!responderUids[uid]) updates[`feeds/${uid}/${broadcastUid}`] = null
        }
        for (const group of Object.values(broadcastRecepients.groups || {})) {
            for (const uid of Object.keys(group.members)) {
                if (!responderUids[uid]) updates[`feeds/${uid}/${broadcastUid}`] = null
            }
        }
        updates[`/activeBroadcasts/${broadcasterUid}/public/${broadcastUid}/locked`] = true
    }

    await database.ref().update(updates);
})

const generateRecepientObject = 
    async (data : BroadcastCreationRequest, userUid : string) : Promise<CompleteRecepientList> => {

    let allFriends = {} as { [key: string]: boolean; }
    const allRecepients = {direct: {}, groups: {}} as CompleteRecepientList

    const maskRetrievalPromise = async (maskUid : string) => {
        const maskMembers = 
        (await database.ref(`/userFriendGroupings/${userUid}/custom/details/${maskUid}/memberUids`)
            .once("value")).val()
        
        //Don't throw an error if there are no members, since a user is allowed
        //to have empty masks
        allRecepients.direct = {...maskMembers, ...allRecepients.direct}
    }

    const groupRetrievalPromise = async (groupUid : string) => {
        const groupName = 
        (await database.ref(`userGroupMemberships/${userUid}/${groupUid}/name`)
            .once("value")).val()
        if (!groupName){
            throw new functions.https.HttpsError(
                "failed-precondition", "You're not a member of one of these groups")
        }

        const members = 
        (await database.ref(`/userGroups/${groupUid}/memberUids`)
            .once("value")).val()
        delete members[userUid] //So the sender does't get sent his own broadcast

        allRecepients.groups[groupUid] = {groupName, members}
    }

    const friendRetrievalPromise = async () => {
        allFriends = 
        (await database.ref(`/userFriendGroupings/${userUid}/_masterUIDs`)
            .once("value")).val()
    }

    const retrievalPromises : Array<Promise<void>> = []
    retrievalPromises.push(friendRetrievalPromise())
    //If the user has opted to use all friends, there's no use in using the provided
    //recepient masks
    if (!data.allFriends){
        for (const maskUid in data.maskRecepients) {
            retrievalPromises.push(maskRetrievalPromise(maskUid))
        }
    }
    for (const groupUid in data.groupRecepients) {
        retrievalPromises.push(groupRetrievalPromise(groupUid))
    }
    await Promise.all(retrievalPromises)
    
    //Almost everything's constructed, now I jsut have to manually
    //make sure that all of the manually included friend uids are part of 
    //the retrieved complete list of friend uids (if applicable)
    if (data.allFriends){
        allRecepients.direct = allFriends
    }else{
        for (const friendUid in data.friendRecepients) {
            if (allFriends[friendUid]) allRecepients.direct[friendUid] = true
            else throw new functions.https.HttpsError("failed-precondition", "Non-friend uid provided")
        }
    }
    return allRecepients;
}

const isRealRecepient = (broadcastRecepients : CompleteRecepientList, uid : string) : boolean => {
    //First check the direct recepients
    if (broadcastRecepients.direct[uid]) return true;

    //Now check the groups
    if (!broadcastRecepients.groups) return false;
    for (const group of Object.values(broadcastRecepients.groups)) {
        if (group.members[uid]) return true
    }
    return false;
}

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

//Gets paths to all the active braodcast data related to the user
export interface activeBroadcastPaths {
    userFeed : string,
    broadcastResponseSnippets: Array<string>,
    broadcastResponseUids: Array<string>,
    activeBroadcastSection: string,
    broadcastsFeedPaths: Array<string>,
}

export const getAllActiveBroadcastPaths = async (userUid : string) : Promise<activeBroadcastPaths> => {
    const paths : activeBroadcastPaths = {
        userFeed : "",
        broadcastResponseSnippets: [],
        broadcastResponseUids: [],
        activeBroadcastSection: "string",
        broadcastsFeedPaths: [],
    }
    // 1) Path to your feed
    paths.userFeed = `feeds/${userUid}`

    // 2) Paths to everyone who has your snippet in their active broadcasts sections
    const completeFeed = (await database.ref(`feeds/${userUid}`).once("value")).val()
    for (const broadcastUid in completeFeed) {
        const broadcast = completeFeed[broadcastUid]
        if (!broadcast.status) continue
        const broadcasterUid = broadcast.owner.uid
        paths.broadcastResponseSnippets.push(`activeBroadcasts/${broadcasterUid}/responders/${broadcastUid}/${userUid}`) 
        paths.broadcastResponseUids.push(`/activeBroadcasts/${broadcasterUid}/private/${broadcastUid}/responderUids/${userUid}`)
    } 

    // 3) Path to your active broadcast section
    paths.activeBroadcastSection = `activeBroadcasts/${userUid}`

    // 4) Paths to all your broadcasts in people's feeds
    const allBroadcastRecepientLists = (await database.ref(`activeBroadcasts/${userUid}/private`).once("value")).val()
    for (const broadcastUid in allBroadcastRecepientLists) {
        const recepeintList : CompleteRecepientList = allBroadcastRecepientLists[broadcastUid].recepientUids
        for (const directReceientUid in recepeintList.direct) {
            paths.broadcastsFeedPaths.push(`feeds/${directReceientUid}/${broadcastUid}`)
        }
        for (const groupUid in recepeintList.groups) {
            const groupMembers = recepeintList.groups[groupUid].members
            for (const memberUid in groupMembers){
                paths.broadcastsFeedPaths.push(`feeds/${memberUid}/${broadcastUid}`)
            }
        }
    } 
    return paths
}