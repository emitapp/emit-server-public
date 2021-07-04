//TODO: Purge masks from this file (and the other files that link to it)
import * as functions from 'firebase-functions';
import admin = require('firebase-admin');
import { isEmptyObject, truncate, handleError, successReport, errorReport, isOnlyWhitespace } from '../utils/utilities';
import { cancelTask, enqueueTask, runTask } from '../utils/cloudTasks'
import * as common from './common'
import { geohashForLocation } from 'geofire-common'
import { UserSnippet } from '../accountManagementFunctions';
import { FlareDays } from './common';

const logger = functions.logger

interface BroadcastCreationRequest {
    ownerUid: string,

    emoji: string,
    activity: string,
    startingTime: number, //Eg: In 5 minutes vs at 12:35am
    startingTimeRelative: boolean,
    location?: string,
    geolocation?: { latitude: number, longitude: number },
    duration: number,

    note?: string,

    allFriends: boolean,
    maxResponders?: number,
    friendRecepients: { [key: string]: boolean; },
    maskRecepients: { [key: string]: boolean; },
    groupRecepients: { [key: string]: boolean; },

    //For recurrence
    recurringDays: FlareDays[],
    originalFlareUid?: string // only for recurring flares, used as a unique ID, never provided by user


    customMaxResponders: boolean,

    //Useful for flare editing...
    broadcastUid?: string, //Only when editing the flare...
    friendsToRemove: string[],
    groupsToRemove: string[]
}

interface DeletionRequest {
    uid: string,
    ownerUid: string
}

interface DeletionTaskPayload {
    paths: { [key: string]: null }
}

export interface CompleteRecepientList {
    direct: { [key: string]: boolean; },
    groups: { [key: string]: RecepientGroupInfo },

    //These are onyl used for anaytics
    totalRecepients: number,
    totalGroupRecepients: number,
    totalDirectRecepients: number,
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

interface PrivateFlareFeedElement {
    owner: UserSnippetWithUid,
    deathTimestamp: number,
    duration: number,
    startingTime: number,
    activity: string,
    emoji: string,
    location?: string
    note?: string
    geoHash?: string
    geolocation?: {
        latitude: number,
        longitude: number
    },
    recurringDays: FlareDays[]
}

interface UserSnippetWithUid extends UserSnippet {
    uid: string
}


interface PrivateFlarePublicData extends PrivateFlareFeedElement {
    totalConfirmations: number,
    slug: string,
    slugPrivate: boolean
    recurringDays: FlareDays[]
}

interface PrivateFlareAdditionalData {
    allFriends: boolean,
    friendRecepients: { [key: string]: boolean; },
    groupRecepients: { [key: string]: boolean; },
    customMaxResponders: boolean,
    maxResponders?: number,
}

interface PrivateFlarePrivateData {
    cancellationTaskPath: string,
    recepientUids: CompleteRecepientList,
    confirmationCap: number | null,
    ga_analytics: Record<string, any>,
    responderUids: Record<string, true | null>,
}

const database = admin.database()


/**
 * This creates an active broadcast for a user, and sets it ttl (time to live)
 */
export const createActiveBroadcast = functions.https.onCall(
    async (data: BroadcastCreationRequest, context) => {
        try {
            if (!context.auth) {
                throw errorReport("Authentication Needed")
            }

            if (context.auth.uid !== data.ownerUid) {
                throw errorReport('Your auth token doens\'t match');
            }

            validateBroadcast(data);
            const newBroadcastUid = await createPrivateFlare(data);
            return successReport({ flareUid: newBroadcastUid })
        } catch (err) {
            return handleError(err)
        }
    });


/**
* This function is called as a Cloud Task and merely serves as a wrapper
* for createActiveBroadcast()
*/
export const createActiveBroadcastCloudTask =
    functions.https.onRequest(async (req, res) => {
        try {
            validateBroadcast(req.body)
            await createPrivateFlare(req.body)
            res.sendStatus(200)
        } catch (error) {
            logger.error("createPublicFlareCloudTask error", error)
            res.status(500).send(error)
        }

    })

/**
 * This edits an existing broadcast and propagates the change to other users as well
 */
export const modifyActiveBroadcast = functions.https.onCall(
    async (data: BroadcastCreationRequest, context) => {
        try {
            if (!context.auth) {
                throw errorReport("Authentication Needed")
            }

            if (context.auth.uid !== data.ownerUid) {
                throw errorReport('Your auth token doens\'t match');
            }

            validateBroadcast(data);
            const broadcastUid = await editPrivateFlare(data)
            return successReport({ flareUid: broadcastUid })
        } catch (err) {
            return handleError(err)
        }
    });

const validateBroadcast = (data: BroadcastCreationRequest) => {

    if (data.maxResponders && !Number.isInteger(data.maxResponders)) {
        throw errorReport("Invalid responder cap");
    }

    if (!data.allFriends
        && isEmptyObject(data.friendRecepients)
        && isEmptyObject(data.maskRecepients)
        && isEmptyObject(data.groupRecepients)) {
        throw errorReport(`Your broadcast has no recepients!`);
    }

    if (data.note && data.note.length > common.MAX_BROADCAST_NOTE_LENGTH) {
        throw errorReport(`Broadcast note too long`);
    }

    if (data.location && data.location.length > common.MAX_LOCATION_NAME_LENGTH) {
        throw errorReport(`Broadcast location name too long`);
    }
}

const createPrivateFlare = async (data: BroadcastCreationRequest): Promise<string | null | undefined> => {

    //Setting things up for the batch write
    const updates = {} as Record<string, any>;
    const nulledPaths = {} as Record<string, null>; //Needed for the deletion cloud task

    const userBroadcastSection = `activeBroadcasts/${data.ownerUid}`
    const broadcastUid = (await database.ref(userBroadcastSection).push()).key as string

    // Don't need to change slug if it's an edited broadcast
    const slug = await common.getAvailableFlareSlug(6)
    const slugInfo = { flareUid: broadcastUid, ownerUid: data.ownerUid, private: false, firestore: false }
    addWriteDelete(updates, nulledPaths, `flareSlugs/${slug}`, slugInfo)

    const ownerSnippetSnapshot = await database.ref(`userSnippets/${data.ownerUid}`).once('value');
    if (!ownerSnippetSnapshot.exists()) {
        throw errorReport(`Owner snapshot missing - your account isn't set up yet`);
    }
    const owner: UserSnippetWithUid = { uid: data.ownerUid, ...ownerSnippetSnapshot.val() }

    const { startingTime, deathTime } = calculateFlareTimeVariables(data);

    //Making the object that will actually be in people's feeds
    const feedBroadcastObject = generateFeedObject(data, deathTime, startingTime, owner)

    //Now populating people's feeds
    const allRecepients = await generateRecepientObject(data, data.ownerUid)
    writeToFeeds(updates, nulledPaths, broadcastUid, feedBroadcastObject, allRecepients)

    const {
        broadcastPublicData,
        broadcastAdditionalParams,
        broadcastPrivateData
    } = makePrivateFlareMetadata(data, feedBroadcastObject, slug, allRecepients, broadcastUid)


    addWriteDelete(updates, nulledPaths, userBroadcastSection + "/public/" + broadcastUid, broadcastPublicData)
    addWriteDelete(updates, nulledPaths, userBroadcastSection + "/additionalParams/" + broadcastUid, broadcastAdditionalParams)
    addWriteDelete(updates, nulledPaths, userBroadcastSection + "/private/" + broadcastUid, broadcastPrivateData)
    addWriteDelete(updates, nulledPaths, userBroadcastSection + "/responders/" + broadcastUid)
    addWriteDelete(updates, nulledPaths, userBroadcastSection + "/chats/" + broadcastUid)

    //Enqueueing the deletion task
    //Then giving the broadcast it's deletion task's id (in case we want to cancel the scheduled deletion or something)
    const payload: DeletionTaskPayload = { paths: nulledPaths }
    const response = await enqueueTask(common.TASKS_QUEUE, "autoDeleteBroadcast", payload, deathTime)
    updates[userBroadcastSection + "/private/" + broadcastUid].cancellationTaskPath = response.name

    // If flare is recurring, enqueue the createPublicFlareCloudTask
    if (data.recurringDays?.length > 0) {

        if (!data.originalFlareUid) {
            data.originalFlareUid = broadcastUid
        }

        // enqueue next task
        const nextExecutionTime = common.computeNextExecutionTime(data.recurringDays, startingTime)
        const cloudTaskResponse = await enqueueTask(common.TASKS_QUEUE, "createActiveBroadcastCloudTask", data, nextExecutionTime)

        // maintain unique identifier for recurring flares as the original flare id, as the flare
        // id changes each time this function is called
        updates[`recurringFlares/${data.ownerUid}/${data.originalFlareUid}`] = {
            ...feedBroadcastObject,
            originalFlareUid: data.originalFlareUid,
            frequency: data.recurringDays.join("/"),
            cloudTaskName: cloudTaskResponse.name
        }
    }

    //And lastly, doing the batch writes
    await database.ref().update(updates);
    return broadcastUid
}

const editPrivateFlare = async (data: BroadcastCreationRequest): Promise<string | null | undefined> => {
    if (!data.broadcastUid) {
        throw errorReport("No Uid provided!")
    }

    //Setting things up for the batch write
    const updates = {} as Record<string, any>;
    const nulledPaths = {} as Record<string, null>; //Needed for the deletion cloud task

    const userBroadcastSection = `activeBroadcasts/${data.ownerUid}`

    const userBroadcasts = await database.ref(`activeBroadcasts/${data.ownerUid}`).once('value');
    const userBroadcastData = userBroadcasts.val()
    if (!userBroadcastData) {
        throw errorReport(`User doesn't have any flares`);
    }

    const privateData: PrivateFlarePrivateData = userBroadcastData.private[`${data.broadcastUid}`]
    const publicData: PrivateFlarePublicData = userBroadcastData.public[`${data.broadcastUid}`]
    const additionalParams: PrivateFlareAdditionalData = userBroadcastData.additionalParams[`${data.broadcastUid}`]

    if (!(publicData && privateData && additionalParams)) {
        throw errorReport(`Invalid flare uid`);
    }

    const broadcastUid = data.broadcastUid
    const owner = publicData.owner
    const cancellationTaskPath = privateData.cancellationTaskPath

    //Presering flare information
    const slug = publicData.slug
    addWriteDelete(updates, nulledPaths, `flareSlugs/${slug}`)

    const { startingTime: newStartingTime, deathTime: newDeathTime } = calculateFlareTimeVariables(data)

    //Making the object that will actually be in people's feeds
    const feedBroadcastObject = generateFeedObject(data, newDeathTime, newStartingTime, owner)
    const allRecepients = await generateRecepientObject(data, publicData.owner.uid)
    writeToFeeds(updates, nulledPaths, broadcastUid, feedBroadcastObject, allRecepients)

    const {
        broadcastPublicData,
        broadcastAdditionalParams,
        broadcastPrivateData
    } = makePrivateFlareMetadata(data, feedBroadcastObject, slug, allRecepients, broadcastUid)

    const responderUidsSnapshot = await database.ref(`activeBroadcasts/${owner.uid}/private/${broadcastUid}/responderUids`).once('value');
    const responderUids = responderUidsSnapshot.val() || {}
    broadcastPrivateData.responderUids = responderUids

    // Need to explicitly delete the flare from the feeds of people who have been removed from the reciepient list
    // FIXME: can make total confirmations count inaccurate, should move that logic to a trigger eventually
    // I also shouldn't be messing with responderUids directly outside of its main trigger func
    let newResponderCount = Object.keys(responderUids).length

    for (const friendUid of data.friendsToRemove) {
        updates[`activeBroadcasts/${owner.uid}/responders/${broadcastUid}/${friendUid}`] = null
        if (responderUids[friendUid]) newResponderCount -= 1;
        broadcastPrivateData.responderUids[friendUid] = null
        updates[`feeds/${friendUid}/${broadcastUid}`] = null
    }

    for (const groupUid of data.groupsToRemove) {
        for (const memberUid in privateData.recepientUids.groups[groupUid].members) {
            updates[`activeBroadcasts/${owner.uid}/responders/${broadcastUid}/${memberUid}`] = null
            if (responderUids[memberUid]) newResponderCount -= 1;
            broadcastPrivateData.responderUids[memberUid] = null
            updates[`feeds/${memberUid}/${broadcastUid}`] = null
        }
    }

    //TODO: this should eventually just be handled with triggers. Its cleaner, set it and forget it.
    broadcastPublicData.totalConfirmations = newResponderCount;
    addWriteDelete(updates, nulledPaths, userBroadcastSection + "/public/" + broadcastUid, broadcastPublicData)
    addWriteDelete(updates, nulledPaths, userBroadcastSection + "/additionalParams/" + broadcastUid, broadcastAdditionalParams)
    addWriteDelete(updates, nulledPaths, userBroadcastSection + "/private/" + broadcastUid, broadcastPrivateData)
    addWriteDelete(updates, nulledPaths, userBroadcastSection + "/responders/" + broadcastUid)
    addWriteDelete(updates, nulledPaths, userBroadcastSection + "/chats/" + broadcastUid)

    //order is particularly important here.
    //we only want to cancel the old task if we already successfully made the new one
    const payload: DeletionTaskPayload = { paths: nulledPaths }
    const response = await enqueueTask(common.TASKS_QUEUE, "autoDeleteBroadcast", payload, newDeathTime)
    updates[userBroadcastSection + "/private/" + broadcastUid].cancellationTaskPath = response.name
    await cancelTask(cancellationTaskPath)

    //And lastly, doing the batch writes
    await database.ref().update(updates);
    return broadcastUid
}

export const deleteBroadcast = functions.https.onCall(
    async (data: DeletionRequest, context) => {
        try {
            if (!context.auth) {
                throw errorReport("Authentication Needed")
            }

            if (context.auth.uid !== data.ownerUid) {
                throw errorReport('Your auth token doens\'t match');
            }

            const privateBroadcastSnapshot = await database
                .ref(`activeBroadcasts/${data.ownerUid}/private/${data.uid}`)
                .once('value');
            const publicBroadcastSnapshot = await database
                .ref(`activeBroadcasts/${data.ownerUid}/public/${data.uid}`)
                .once('value');
            if (!privateBroadcastSnapshot.exists() || !publicBroadcastSnapshot.exists()) {
                throw errorReport(`Invalid broadcast uid`);
            }

            await runTask(privateBroadcastSnapshot.val().cancellationTaskPath)
            return successReport({ uid: data.uid })
        } catch (err) {
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

        try {
            if (!context.auth) {
                throw errorReport("Authentication Needed")
            }

            const uid = context.auth.uid;

            if (isOnlyWhitespace(data.broadcastUid)) {
                throw errorReport('Invalid broadcast uid');
            }

            const broadcastRecepients =
                (await database
                    .ref(`activeBroadcasts/${data.broadcasterUid}/private/${data.broadcastUid}/recepientUids`)
                    .once('value')).val()
            if (broadcastRecepients === null) {
                throw errorReport('This broadcast doesn\'t exist.');
            }

            const responderSnippetSnapshot = await database.ref(`userSnippets/${uid}`).once('value');
            if (!responderSnippetSnapshot.exists()) {
                throw errorReport(`Your account isn't set up yet`);
            }
            const responderSnippet = responderSnippetSnapshot.val()

            if (!isBroadcastRecepient(broadcastRecepients, uid)) {
                throw errorReport('Responder was never a recepient');
            }

            const respondersPath = `activeBroadcasts/${data.broadcasterUid}/responders/${data.broadcastUid}/${uid}`
            const statusPath = `feeds/${uid}/${data.broadcastUid}/status`

            const chatPath = `/activeBroadcasts/${data.broadcasterUid}/chats/${data.broadcastUid}/`
            const chatId = (await database.ref(chatPath).push()).key
            const chatMessage = {
                _id: chatId,
                createdAt: Date.now(),
                system: true,
                user: { _id: "-", name: "-" } //TODO: For backwards compatability, can be removed in a few weeks 
            } as any

            // if attendOrRemove param is not passed in (to account for old code not using this)
            // or it's true, confirm the user for the event
            const updates: any = {}
            if (data.attendOrRemove) {
                updates[respondersPath] = responderSnippetSnapshot.val()
                updates[statusPath] = "confirmed"  // Also making sure this reflects on the responder's feed

                chatMessage.text = `${responderSnippet.displayName} (@${responderSnippet.username}) is in!`
                updates[chatPath + chatId] = chatMessage
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
                chatMessage.text = `${responderSnippet.displayName} (@${responderSnippet.username}) is out.`
                updates[chatPath + chatId] = chatMessage
                await database.ref().update(updates);
                await responderRef.remove()

                // Decrementing the response counter now
                const confirmCounterRef = database.ref(`/activeBroadcasts/${data.broadcasterUid}/public/${data.broadcastUid}/totalConfirmations`)
                await confirmCounterRef.transaction(count => count - 1)
            }
            return successReport()
        } catch (err) {
            return handleError(err)
        }
    })

// This assumes that 
// /activeBroadcasts/${broadcasterUid}/public/${broadcastUid}/totalConfirmations and 
// /activeBroadcasts/{broadcasterUid}/responders/{broadcastUid}/{newResponderUid} are updated at the same time
export const lockBroadcastIfNeeded = functions.database.ref('activeBroadcasts/{broadcasterUid}/responders/{broadcastUid}/{newResponderUid}')
    .onCreate(async (_, context) => {

        const { broadcasterUid, broadcastUid, newResponderUid } = context.params
        const updates = {} as any
        updates[`/activeBroadcasts/${broadcasterUid}/private/${broadcastUid}/responderUids/${newResponderUid}`] = true

        const confirmationCap = (await
            database.ref(`/activeBroadcasts/${broadcasterUid}/private/${broadcastUid}/confirmationCap`).once("value"))
            .val()

        const currentConfirmationCount = (await
            database.ref(`/activeBroadcasts/${broadcasterUid}/public/${broadcastUid}/totalConfirmations`).once("value"))
            .val()

        if (confirmationCap && currentConfirmationCount >= confirmationCap) { //Time to lock down the broadcast. Delete it from every non-responder's feed
            const responderUidsRef = database.ref(`/activeBroadcasts/${broadcasterUid}/private/${broadcastUid}/responderUids`)
            const responderUids = { ...(await responderUidsRef.once("value")).val() }
            responderUids[newResponderUid] = true //Adding this new responder to the calulcation (since he isn't in the server's record yet)
            const broadcastRecepients: CompleteRecepientList = (await database
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


//Gets paths to all the active braodcast data related to the user
export interface activeBroadcastPaths {
    userFeed: string,
    broadcastResponseSnippets: Array<string>,
    broadcastResponseUids: Array<string>,
    activeBroadcastSection: string,
    broadcastsFeedPaths: Array<string>,
}

export const getAllActiveBroadcastPaths = async (userUid: string): Promise<activeBroadcastPaths> => {
    const paths: activeBroadcastPaths = {
        userFeed: "",
        broadcastResponseSnippets: [],
        broadcastResponseUids: [],
        activeBroadcastSection: "",
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
        const recepeintList: CompleteRecepientList = allBroadcastRecepientLists[broadcastUid].recepientUids
        for (const directReceientUid in recepeintList.direct) {
            paths.broadcastsFeedPaths.push(`feeds/${directReceientUid}/${broadcastUid}`)
        }
        for (const groupUid in recepeintList.groups) {
            const groupMembers = recepeintList.groups[groupUid].members
            for (const memberUid in groupMembers) {
                paths.broadcastsFeedPaths.push(`feeds/${memberUid}/${broadcastUid}`)
            }
        }
    }
    return paths
}


const generateRecepientObject =
    async (data: BroadcastCreationRequest, userUid: string): Promise<CompleteRecepientList> => {

        let allFriends = {} as { [key: string]: boolean; }
        const allRecepients: CompleteRecepientList = {
            direct: {},
            groups: {},
            totalRecepients: 0,
            totalDirectRecepients: 0,
            totalGroupRecepients: 0
        }

        const maskRetrievalPromise = async (maskUid: string) => {
            const maskMembers =
                (await database.ref(`/userFriendGroupings/${userUid}/custom/details/${maskUid}/memberUids`)
                    .once("value")).val()

            //Don't throw an error if there are no members, since a user is allowed
            //to have empty masks
            allRecepients.direct = { ...maskMembers, ...allRecepients.direct }
        }

        const groupRetrievalPromise = async (groupUid: string) => {
            const groupName =
                (await database.ref(`userGroupMemberships/${userUid}/${groupUid}/name`)
                    .once("value")).val()
            if (!groupName) {
                throw errorReport("You're not a member of one of these groups")
            }

            const members =
                (await database.ref(`/userGroups/${groupUid}/memberUids`)
                    .once("value")).val()
            delete members[userUid] //So the sender does't get sent his own broadcast

            allRecepients.groups[groupUid] = { groupName, members }
            allRecepients.totalGroupRecepients += Object.keys(members).length
        }

        const friendRetrievalPromise = async () => {
            allFriends =
                (await database.ref(`/userFriendGroupings/${userUid}/_masterUIDs`)
                    .once("value")).val()
        }

        const retrievalPromises: Array<Promise<void>> = []
        retrievalPromises.push(friendRetrievalPromise())
        //If the user has opted to use all friends, there's no use in using the provided
        //recepient masks
        if (!data.allFriends) {
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
        if (data.allFriends) {
            allRecepients.direct = allFriends
        } else {
            for (const friendUid in data.friendRecepients) {
                if (allFriends[friendUid]) allRecepients.direct[friendUid] = true
                else throw errorReport("Non-friend uid provided")
            }
        }

        allRecepients.totalDirectRecepients = Object.keys(allRecepients.direct).length
        //TODO: This allows for overlap since I can have someone who's both in a group (or even worse,
        // numerous groups!) and also be a direct recepient
        allRecepients.totalRecepients = allRecepients.totalDirectRecepients + allRecepients.totalGroupRecepients
        return allRecepients;
    }


const isBroadcastRecepient = (broadcastRecepients: CompleteRecepientList, uid: string): boolean => {
    //First check the direct recepients
    if (broadcastRecepients.direct && broadcastRecepients.direct[uid]) return true;

    //Now check the groups
    if (!broadcastRecepients.groups) return false;
    for (const group of Object.values(broadcastRecepients.groups)) {
        if (group.members[uid]) return true
    }
    return false;
}


const calculateFlareTimeVariables = (data: BroadcastCreationRequest) => {
    let deathTime = 0
    let startingTime = data.startingTime
    if (data.startingTimeRelative) startingTime += Date.now();
    else if (data.startingTime < Date.now()) startingTime = Date.now(); //Any flare set to start "in the past" for any reason starts now
    deathTime = startingTime + data.duration;

    if (isNaN(deathTime) || deathTime > (Date.now() + common.FLARE_LIFETIME_CAP_MINS * 60000)) {
        throw errorReport(`Your flare can't last for more than 48 hours`);
    }

    return { startingTime, deathTime }
}


const addWriteDelete = (
    writeObject: Record<string, any>,
    nullObject: Record<string, null>,
    path: string,
    value?: any) => {
    if (typeof value != "undefined") writeObject[path] = value
    nullObject[path] = null
}


const generateFeedObject = (data: BroadcastCreationRequest, deathTime: number, startingTime: number, ownerSnippet: UserSnippetWithUid) => {
    const feedBroadcastObject: PrivateFlareFeedElement = {
        owner: ownerSnippet,
        deathTimestamp: deathTime,
        duration: data.duration,
        startingTime: startingTime,
        activity: data.activity,
        emoji: data.emoji,
        ...(data.location ? { location: data.location } : {}),
        ...(data.note ? { note: truncate(data.note, 50) } : {}),
        recurringDays: data.recurringDays
    }

    if (data.geolocation) {
        feedBroadcastObject.geolocation = data.geolocation
        feedBroadcastObject.geoHash = geohashForLocation([data.geolocation.latitude, data.geolocation.longitude])
    }
    return feedBroadcastObject
}


const writeToFeeds = (
    writeObject: Record<string, any>,
    nullObject: Record<string, null>,
    uid: string,
    feedObject: PrivateFlareFeedElement,
    allRecepients: CompleteRecepientList) => {
    //The way we're doing this, broadcasts sent via groups will overwrite
    //broadcasts sent via direct uids or masks (if someone got a broadcast via both)
    for (const friendUid in allRecepients.direct) {
        writeObject[`feeds/${friendUid}/${uid}`] = feedObject
        nullObject[`feeds/${friendUid}/${uid}`] = null
    }

    for (const groupUid in allRecepients.groups) {
        const groupInfo = { name: allRecepients.groups[groupUid].groupName, uid: groupUid }
        for (const memberUid in allRecepients.groups[groupUid].members) {
            writeObject[`feeds/${memberUid}/${uid}`] = { ...feedObject, groupInfo }
            nullObject[`feeds/${memberUid}/${uid}`] = null
        }
    }
}


const makePrivateFlareMetadata = (
    data: BroadcastCreationRequest,
    feedObject: PrivateFlareFeedElement,
    slug: string,
    allRecepients: CompleteRecepientList,
    flareUid: string
) => {

    //Active broadcasts are split into 4 sections
    //private (/private) data (only the server should really read and write, though the 
    //owner has read access to the /ga_analytics subdirectory)
    //additionalParams (/additionalParams) data currently functions the same as private, but the owner 
    // should have read access, mainly for additional parameters that client side needs to know for editing
    //public (/public) data (the owner can write, everyone can read)
    //and responder (/responders) data (which can be a bit large, which is 
    //why it is its own section to be loaded only when needed)
    //chat (/chats), which contains the chat associated with the broadcast
    //TODO: move chat to a separate database later on
    //TODO: add in some security rules for chat
    //Note that none of these is the object that's going into people's feeds

    //Identical to the feed object but it has the full note and a responder counter
    const broadcastPublicData: PrivateFlarePublicData = {
        ...feedObject,
        ...(data.note ? { note: data.note } : {}), //overwites the truncated note from feedBroadcastObject
        totalConfirmations: 0,
        slug,
        slugPrivate: false,
        recurringDays: data.recurringDays
    }

    const broadcastAdditionalParams: PrivateFlareAdditionalData = {
        allFriends: data.allFriends,
        friendRecepients: data.friendRecepients,
        groupRecepients: data.groupRecepients,
        customMaxResponders: data.customMaxResponders,
        ...(data.maxResponders ? { maxResponders: data.maxResponders } : {})
    }

    const broadcastPrivateData: PrivateFlarePrivateData = {
        cancellationTaskPath: "",
        recepientUids: allRecepients,
        confirmationCap: data.maxResponders || null,
        responderUids: {},

        //Be sure to limit this to 30 params, that's the limit for Google Analytics
        ga_analytics: {
            flareUid: flareUid,
            ownerUid: data.ownerUid,
            activity: data.activity,
            emoji: data.emoji,
            geolocationAdded: data.geolocation ? true : false,
            noteAdded: data.note ? true : false,
            responderCap: data.maxResponders || 0,
            duration: data.duration,
            startingTime: feedObject.startingTime,
            totalRecepientsNonDistinct: allRecepients.totalRecepients,
            totalDirectRecepientsNonDistinct: allRecepients.totalDirectRecepients,
            totalGroupRecepientsNonDistinct: allRecepients.totalGroupRecepients,
        }
    }

    return { broadcastPublicData, broadcastPrivateData, broadcastAdditionalParams }
}