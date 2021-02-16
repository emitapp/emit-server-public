//TODO: Purge masks from this file (and the other files that link to it)
import * as functions from 'firebase-functions';
//@google-cloud/tasks doesn’t yet support import syntax at time of writing
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { CloudTasksClient } = require('@google-cloud/tasks') 
import admin = require('firebase-admin');
import { isEmptyObject, truncate, handleError, successReport, errorReport, isOnlyWhitespace } from './utilities';

export const MAX_LOCATION_NAME_LENGTH = 100
export const MAX_BROADCAST_NOTE_LENGTH = 500
const logger = functions.logger

interface BroadcastCreationRequest {
    ownerUid: string,

    activity: string,
    emoji: string,
    startingTime: number, //Eg: In 5 minutes vs at 12:35am
    startingTimeRelative: boolean,
    duration: number,

    location?: string,
    geolocation?: {latitude: number, longitude: number},
    note?: string,

    allFriends: boolean,
    maxResponders?: number,
    friendRecepients: { [key: string]: boolean; },
    maskRecepients: { [key: string]: boolean; },
    groupRecepients: { [key: string]: boolean; }
}

interface DeletionTaskPayload {
    paths: { [key: string]: null }
}

export interface CompleteRecepientList {
    direct: { [key: string]: boolean; },
    groups: {[key: string]: RecepientGroupInfo}
}

interface RecepientGroupInfo {
    groupName: string,
    members: { [key: string]: boolean; }
}

interface BroadcastConfirmationReq {
    broadcastUid: string,
    broadcasterUid: string,
    attendOrRemove: boolean
}

const database = admin.database()
const FLARE_LIFETIME_CAP_MINS = 2879 //48 hours - 1 minute
const TASKS_LOCATION = functions.config().env.broadcastCreation.tasks_location
const FUNCTIONS_LOCATION = functions.config().env.broadcastCreation.functions_location
const TASKS_QUEUE = functions.config().env.broadcastCreation.autodelete_task_queue_name
const serviceAccountEmail = functions.config().env.broadcastCreation.service_account_email;

/**
 * This creates an active broadcast for a user, and sets it ttl (time to live)
 */
export const createActiveBroadcast = functions.https.onCall(
    async (data: BroadcastCreationRequest, context) => {
    try{
        // Checking that the user is authenticated.
        if (!context.auth) {
            throw errorReport("Authentication Needed")
        } 

        if (context.auth.uid !== data.ownerUid){
            throw errorReport('Your auth token doens\'t match');
        }   

        if (!data.duration){
            throw errorReport("Invalid duration");
        }

        if (!data.emoji || !data.activity){
            throw errorReport(`Invalid activity`);
        }

        let deathTime = 0; //In milliseconds
        if (data.startingTimeRelative) deathTime += Date.now() + data.startingTime;
        else if (data.startingTime < Date.now()) deathTime = Date.now(); //And flare set to start "in the past" for any reason starts now
        else deathTime = data.startingTime;

        const absoluteStartingTime = deathTime
        deathTime += data.duration;

        if (isNaN(deathTime) || deathTime > (Date.now() + FLARE_LIFETIME_CAP_MINS * 60000)){
            throw errorReport(`Your flare can't last for more than 48 hours`);
        }

        if (data.maxResponders && !Number.isInteger(data.maxResponders)){
            throw errorReport("Invalid responder cap");
        }

        if (!data.allFriends 
            && isEmptyObject(data.friendRecepients) 
            && isEmptyObject(data.maskRecepients) 
            && isEmptyObject(data.groupRecepients)){
            throw errorReport(`Your broadcast has no recepients!`);
        }

        if (data.note && data.note.length > MAX_BROADCAST_NOTE_LENGTH){
            throw errorReport(`Broadcast note too long`);
        }

        if (data.location && data.location.length > MAX_LOCATION_NAME_LENGTH){
            throw errorReport(`Broadcast location name too long`);
        }

        //Setting things up for the batch write
        const updates = {} as any;
        const nulledPaths = {} as any; //Needed for the deletion cloud task
        const userBroadcastSection = `activeBroadcasts/${data.ownerUid}`
        const newBroadcastUid = (await database.ref(userBroadcastSection).push()).key
        
        const ownerSnippetSnapshot = await database.ref(`userSnippets/${data.ownerUid}`).once('value');
        if (!ownerSnippetSnapshot.exists()){
            throw errorReport(`Owner snapshot missing - your account isn't set up yet`);
        }

        //Making the object that will actually be in people's feeds
        const feedBroadcastObject : any = {
            owner: {uid: data.ownerUid, ...ownerSnippetSnapshot.val()},
            deathTimestamp: deathTime, 
            duration: data.duration,
            startingTime: absoluteStartingTime,
            activity: data.activity,
            emoji: data.emoji,
            ...(data.location ? { location: data.location } : {}),
            ...(data.note ? { note: truncate(data.note, 50) } : {})
        }
        if (data.geolocation) feedBroadcastObject.geolocation = data.geolocation

        const allRecepients = await generateRecepientObject(data, context.auth.uid)

        //Now populating people's feeds
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

        //Active broadcasts are split into 4 sections
        //private (/private) data (only the server should really read and write)
        //public (/public) data (the owner can write, everyone can read)
        //and responder (/responders) data (which can be a bit large, which is 
        //why it is its own section to be loaded only when needed)
        //chat (/chat), which contains the chat associated with the broadcast
        //TODO: move chat to a separate database later on
        //TODO: add in some security rules for chat
        //Note that none of these is the object that's going into people's feeds

        //Identical to the feed object but it has the full note and a responder counter
        const broadcastPublicData = {
            ...feedBroadcastObject,
            ...(data.note ? { note: data.note } : {}),
            totalConfirmations: 0,
        }

        const broadcastPrivateData = {
            cancellationTaskPath: "",
            recepientUids: allRecepients,
            confirmationCap: data.maxResponders || null
        }

        updates[userBroadcastSection + "/public/" + newBroadcastUid] = broadcastPublicData
        nulledPaths[userBroadcastSection + "/public/" + newBroadcastUid] = null
        updates[userBroadcastSection + "/private/" + newBroadcastUid] = broadcastPrivateData
        nulledPaths[userBroadcastSection + "/private/" + newBroadcastUid] = null

        //responders section starts off empty
        nulledPaths[userBroadcastSection + "/responders/" + newBroadcastUid] = null

        //Chat section also starts off empty
        nulledPaths[userBroadcastSection + "/chats/" + newBroadcastUid] = null

        //Setting things up for the Cloud Task that will delete this broadcast after its ttl
        const project = JSON.parse(<string>process.env.FIREBASE_CONFIG).projectId
        const tasksClient = new CloudTasksClient()

        //queuePath is going to be a string that is the full path of the queue .
        const queuePath: string = tasksClient.queuePath(project, TASKS_LOCATION, TASKS_QUEUE)

        const deletionFuncUrl = `https://${FUNCTIONS_LOCATION}-${project}.cloudfunctions.net/autoDeleteBroadcast`

        const payload: DeletionTaskPayload = { paths: nulledPaths}

        //Now making the task itself (its an HTTPS request)
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
              seconds: deathTime / 1000 //in epoch seconds
            }
        }

        //Finally actaully enqueueing the deletion task
        const [ response ] = await tasksClient.createTask({ parent: queuePath, task })
        //Then giving the broadcast it's deletion task's id (in case we want to cancel the scheduled deletion or something)
        updates[userBroadcastSection + "/private/" + newBroadcastUid].cancellationTaskPath = response.name

        //And lastly, doing the batch writes
        await database.ref().update(updates);
        return successReport()
    }catch(err){
        return handleError(err)
    }
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
            logger.error("autoDeleteBroadcast error", error)
            res.status(500).send(error)
        }
})

/**
 * This is called to change or set the response of a user 
 * to a broadcast in their feed
 */
export const setBroadcastResponse = functions.https.onCall(
    async (data: BroadcastConfirmationReq, context) => {

    try{
        if (!context.auth) {
            throw errorReport("Authentication Needed")
        }

        const uid = context.auth.uid;

        if (isOnlyWhitespace(data.broadcastUid)){
            throw errorReport('Invalid broadcast uid');
        }

        const broadcastRecepients = 
        (await database
        .ref(`activeBroadcasts/${data.broadcasterUid}/private/${data.broadcastUid}/recepientUids`)
        .once('value')).val()
        if (broadcastRecepients === null){
            throw errorReport('This broadcast doesn\'t exist.');
        }

        const responderSnippetSnapshot = await database.ref(`userSnippets/${uid}`).once('value');
        if (!responderSnippetSnapshot.exists()){
            throw errorReport(`Your account isn't set up yet`);
        }

        if (!isBroadcastRecepient(broadcastRecepients, uid)){
            throw errorReport('Responder was never a recepient');
        }

        const respondersPath = `activeBroadcasts/${data.broadcasterUid}/responders/${data.broadcastUid}/${uid}`
        const statusPath = `feeds/${uid}/${data.broadcastUid}/status`

        // if attendOrRemove param is not passed in (to account for old code not using this)
        // or it's true, confirm the user for the event
        const updates : any = {}
        if (data.attendOrRemove) { 
            updates[respondersPath] = responderSnippetSnapshot.val()
            updates[statusPath] = "confirmed"  // Also making sure this reflects on the responder's feed
            await database.ref().update(updates);
    
            // Incrementing the response counter now
            const confirmCounterRef = database.ref(`/activeBroadcasts/${data.broadcasterUid}/public/${data.broadcastUid}/totalConfirmations`)      
            await confirmCounterRef.transaction(count => count + 1)
            
        // otherwise, if it's false, cancel the user for the event
        } else {
            const statusRef = database.ref(statusPath)
            const statusSnap = await statusRef.once("value")
            const responderRef = database.ref(respondersPath)

            if (!statusSnap.exists() || statusSnap.val() != "confirmed") {
                throw errorReport('Responder has not confirmed yet')
            }
            const responderSnap = await responderRef.once("value")
            if (!responderSnap.exists()) {
                throw errorReport('Responder has not confirmed yet')
            }

            updates[statusPath] = "cancelled"
            await database.ref().update(updates);
            await responderRef.remove()

            // Decrementing the response counter now
            const confirmCounterRef = database.ref(`/activeBroadcasts/${data.broadcasterUid}/public/${data.broadcastUid}/totalConfirmations`)      
            await confirmCounterRef.transaction(count => count - 1)
        }
        return successReport()
    } catch(err) {
        return handleError(err)
    }
})

// This assumes that 
// /activeBroadcasts/${broadcasterUid}/public/${broadcastUid}/totalConfirmations and 
// /activeBroadcasts/{broadcasterUid}/responders/{broadcastUid}/{newResponderUid} are updated at the same time
export const lockBroadcastIfNeeded = functions.database.ref('activeBroadcasts/{broadcasterUid}/responders/{broadcastUid}/{newResponderUid}')
.onCreate(async (_, context) => {

    const {broadcasterUid, broadcastUid, newResponderUid} = context.params
    const updates = {} as any
    updates[`/activeBroadcasts/${broadcasterUid}/private/${broadcastUid}/responderUids/${newResponderUid}`] = true

    const confirmationCap = (await 
        database.ref(`/activeBroadcasts/${broadcasterUid}/private/${broadcastUid}/confirmationCap`).once("value"))
        .val()
    
    const currentConfirmationCount = (await 
        database.ref(`/activeBroadcasts/${broadcasterUid}/public/${broadcastUid}/totalConfirmations`).once("value"))
        .val()

    if (confirmationCap && currentConfirmationCount >= confirmationCap){ //Time to lock down the broadcast. Delete it from every non-responder's feed
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
            throw errorReport("You're not a member of one of these groups")
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
            else throw errorReport("Non-friend uid provided")
        }
    }
    return allRecepients;
}

const isBroadcastRecepient = (broadcastRecepients : CompleteRecepientList, uid : string) : boolean => {
    //First check the direct recepients
    if (broadcastRecepients.direct && broadcastRecepients.direct[uid]) return true;

    //Now check the groups
    if (!broadcastRecepients.groups) return false;
    for (const group of Object.values(broadcastRecepients.groups)) {
        if (group.members[uid]) return true
    }
    return false;
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
