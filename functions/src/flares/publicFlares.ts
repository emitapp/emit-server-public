//Things we gotta do
//analytics
//icing:locking
//icing: which poeple to notify about this public flare

import * as functions from 'firebase-functions';
import { enqueueTask, runTask, cancelTask } from '../utils/cloudTasks';
import { errorReport, handleError, isFunctionExecutionReport, isOnlyWhitespace, successReport, truncate } from '../utils/utilities';
import * as common from './common';
import admin = require('firebase-admin');
import { geohashForLocation } from 'geofire-common'
import { FlareDays } from './common';


interface PublicFlareCreationRequest {
  ownerUid: string,

  activity: string,
  emoji: string,
  startingTime: number, //Eg: In 5 minutes vs at 12:35am
  startingTimeRelative: boolean,
  duration: number,

  location?: string,
  geolocation?: { latitude: number, longitude: number },

  tags?: string[],
  note?: string,
  maxResponders?: number,
  recurringDays: FlareDays[],
  originalFlareUid?: string // only for recurring flares, used as a unique ID, never provided by user
}

interface PublicFlareDeletionRequest {
  ownerUid: string,
  flareUid: string
}

interface PublicFlareDeletionTaskPayload {
  flareUid: string,
  flareSlug: string
}

interface PublicFlareResponsePayload {
  flareUid: string,
  isJoining: boolean
}

const database = admin.database()
const firestore = admin.firestore();
export const publicFlaresCol = firestore.collection("publicFlares")
const shortPubFlareCol = firestore.collection("shortenedPublicFlares")
const logger = functions.logger




/**
 * This creates an active broadcast for a user, and sets it ttl (time to live)
 */
export const createPublicFlare = functions.https.onCall(
  async (data: PublicFlareCreationRequest, context) => {
    try {
      // Basic checks
      if (!context.auth) throw errorReport("Authentication Needed")
      if (context.auth.uid !== data.ownerUid) throw errorReport('Your auth token doesn\'t match')

      const flareUid = await createPublicFlareHelper(data)
      return successReport({ flareUid: flareUid })
    } catch (err) {
      return handleError(err)
    }
  });

/**
 * This function is called as a Cloud Task and merely serves as a wrapper
 * for createPublicFlare()
 */
export const createPublicFlareCloudTask =
  functions.https.onRequest(async (req, res) => {
    try {
      await createPublicFlareHelper(req.body)
      res.sendStatus(200)
    } catch (error) {
      //If this failed and returned a non-fatal report, don't retry since it probably won't
      //work later on either.
      if (isFunctionExecutionReport(error)) res.status(200).send(error)
      logger.error("createPublicFlareCloudTask error", error)
      res.status(500).send(error)
    }
  })

export const editPublicFlare =
  functions.https.onCall(
    async (data: PublicFlareCreationRequest, context) => {
      try {
        if (!context.auth) throw errorReport("Authentication Needed")
        if (context.auth.uid !== data.ownerUid) throw errorReport('Your auth token doesn\'t match')

        const flareUid = await createPublicFlareHelper(data, true)
        return successReport({ flareUid: flareUid })
      } catch (err) {
        return handleError(err)
      }
    });

export const deletePublicFlare =
  functions.https.onCall(
    async (data: PublicFlareDeletionRequest, context) => {
      try {
        if (!context.auth) throw errorReport("Authentication Needed")
        if (context.auth.uid !== data.ownerUid) throw errorReport('Your auth token doesn\'t match')
        const flarePrivateDoc = await publicFlaresCol.doc(data.flareUid).collection("private").doc("private").get()
        const privateData = flarePrivateDoc.data()
        if (!privateData) throw errorReport("Failed to fetch flare private data")

        await runTask(privateData.cancellationTaskPath)

        return successReport({ flareUid: data.flareUid })
      } catch (err) {
        return handleError(err)
      }
    });


/**
 * Helper function for createPublicFlareCloudTask and createPublicFlare
 * handles core logic of creating a public flare
 * If the flare is being edited, it is assumed that the originalFlareUid is added
 */
export const createPublicFlareHelper = async (data: PublicFlareCreationRequest, isEditing?: boolean): Promise<string> => {

  let existingFlareObject = undefined
  let oldCancellationTaskPath = undefined

  if (isEditing && !data.originalFlareUid) throw errorReport("Editing flare but no flare ID provided")

  if (isEditing) {
    const existingFlareDoc = await publicFlaresCol.doc(data.originalFlareUid as string).get()
    if (!existingFlareDoc.data()) throw errorReport("There is no flare to edit")
    existingFlareObject = existingFlareDoc.data()
    if (existingFlareObject?.owner?.uid != data.ownerUid) throw errorReport("You don't own this flare.")

    const flarePrivateDoc = await publicFlaresCol.doc(data.originalFlareUid as string).collection("private").doc("private").get()
    if (!flarePrivateDoc.data()) throw errorReport("Could not get privare flare information of to-be-edited flare")
    oldCancellationTaskPath = flarePrivateDoc.data()?.cancellationTaskPath
  }

  if (!data.duration) throw errorReport("Invalid duration");
  if (!data.emoji || !data.activity) throw errorReport(`Invalid activity`);

  let deathTime = 0; //In milliseconds
  if (data.startingTimeRelative) deathTime += Date.now() + data.startingTime;
  //If the flare was set to start "in the past" for any reason starts now
  else if (data.startingTime < Date.now()) deathTime = Date.now();
  else deathTime = data.startingTime;

  const absoluteStartingTime = deathTime
  deathTime += data.duration;

  if (isNaN(deathTime) || deathTime > (Date.now() + common.FLARE_LIFETIME_CAP_MINS * 60000)) {
    throw errorReport(`Your flare can't last for more than 48 hours`);
  }

  if (data.maxResponders && !Number.isInteger(data.maxResponders)) {
    throw errorReport("Invalid responder cap");
  }

  if (data.note && data.note.length > common.MAX_BROADCAST_NOTE_LENGTH) {
    throw errorReport(`Broadcast note too long`);
  }

  if (data.location && data.location.length > common.MAX_LOCATION_NAME_LENGTH) {
    throw errorReport(`Broadcast location name too long`);
  }

  //Making the full and the shortened flare docs
  // If flareUid already exists, we're probably in edit mode right now
  //TODO: Find a firestore way to do this (the next PR is planned to do this, iirc)
  const flareUid = isEditing ? data.originalFlareUid : <string>(await database.ref().push()).key 

  if (!flareUid) throw errorReport(`Invalid FlareUid`)

  const ownerSnippetSnapshot = await database.ref(`userSnippets/${data.ownerUid}`).once('value');
  if (!ownerSnippetSnapshot.exists()) {
    throw errorReport(`Owner snapshot missing - your account isn't set up yet`);
  }

  //Making the object that will actually be in people's feeds
  const shortenedFlareObject: any = {
    owner: { uid: data.ownerUid, ...ownerSnippetSnapshot.val() },
    deathTimestamp: deathTime,
    duration: data.duration,
    startingTime: absoluteStartingTime,
    activity: data.activity,
    emoji: data.emoji,
    ...(data.location ? { location: data.location } : {}),
    ...(data.note ? { note: truncate(data.note, 50) } : {}),
    ...(data.tags ? { tags: data.tags } : {}),
    recurringDays: data.recurringDays
  }

  if (data.geolocation) {
    shortenedFlareObject.geolocation = data.geolocation
    shortenedFlareObject.geoHash = geohashForLocation([data.geolocation.latitude, data.geolocation.longitude])
  }


  const promises: Array<Promise<any>> = []
  const rtdbAdditions: Record<string, any> = {}

  let flareSlug = null
  //Making the flare's URL slug...
  if (existingFlareObject) {
    flareSlug = existingFlareObject.slug
  } else {
    flareSlug = await common.getAvailableFlareSlug(6)
    rtdbAdditions[`flareSlugs/${flareSlug}`] = { flareUid: flareUid, ownerUid: data.ownerUid, private: false, firestore: true }
  }

  //Identical to the feed object but it has the full note and a responder counter and a list of responders
  const fullFlareObject = {
    ...shortenedFlareObject,
    ...(data.note ? { note: data.note } : {}),
    ...(data.maxResponders ? { maxResponders: data.maxResponders } : {}),
    startingTimeRelative: data.startingTimeRelative,
    totalConfirmations: 0,
    responders: [], //FIXME: is this a good idea? not sure
    slug: flareSlug,
    slugPrivate: false,

  }

  //Enqueueing the deletion task
  const payload: PublicFlareDeletionTaskPayload = { flareUid, flareSlug }
  const response = await enqueueTask(common.TASKS_QUEUE, "autoPublicFlareDeletion", payload, deathTime)

  const privateFlareInformation = {
    cancellationTaskPath: response.name,
    confirmationCap: data.maxResponders || null
  }

  // If flare is recurring, enqueue the createPublicFlareCloudTask
  // This should only be done if the flare is being created for the first time.
  if (data.recurringDays?.length > 0 && !isEditing) {

    // enqueue next task
    const nextExecutionTime = common.computeNextExecutionTime(data.recurringDays, absoluteStartingTime)
    const cloudTaskResponse = await enqueueTask(common.TASKS_QUEUE, "createPublicFlareCloudTask", data, nextExecutionTime)
    const executionCloudTaskName = cloudTaskResponse.name
    // maintain unique identifier for recurring flares as the original flare id, as the flare
    // id changes each time this function is called
    rtdbAdditions[`recurringFlares/${data.ownerUid}/${flareUid}`] = {
      ...shortenedFlareObject,
      originalFlareUid: flareUid,
      frequency: data.recurringDays.join("/"),
      cloudTaskName: executionCloudTaskName
    }
  }

  //Doing the writes...
  promises.push(publicFlaresCol.doc(flareUid).set(fullFlareObject))
  promises.push(shortPubFlareCol.doc(flareUid).set(shortenedFlareObject))
  promises.push(publicFlaresCol.doc(flareUid).collection("private").doc("private").set(privateFlareInformation))
  promises.push(database.ref().update(rtdbAdditions));
  await Promise.all(promises)

  if (isEditing) {
    await cancelTask(oldCancellationTaskPath)
  }

  return flareUid
}



/**
 * This function is called automatically (using Cloud Tasks) to delete public flares
 */
export const autoPublicFlareDeletion =
  functions.https.onRequest(async (req, res) => {

    const payload = req.body as PublicFlareDeletionTaskPayload
    try {
      const promises: Array<Promise<any>> = []
      const rtdbDeletions: Record<string, null> = {}

      //Deleting the 3 flare docs
      const { flareUid, flareSlug } = payload
      promises.push(shortPubFlareCol.doc(flareUid).delete())
      promises.push(publicFlaresCol.doc(flareUid).delete())
      promises.push(publicFlaresCol.doc(flareUid).collection("private").doc("private").delete())

      //Deleting the responders
      const responders = await publicFlaresCol.doc(flareUid).collection("responders").get()
      responders.forEach(doc => promises.push(doc.ref.delete()))

      //Deleting the data stored on RTBD
      rtdbDeletions[`flareSlugs/${flareSlug}`] = null
      rtdbDeletions[`publicFlareChats/${flareUid}`] = null
      promises.push(database.ref().update(rtdbDeletions));

      await Promise.all(promises)
      res.sendStatus(200)
    }
    catch (error) {
      logger.error("autoPublicFlareDeletion error", error)
      res.status(500).send(error)
    }
  })


export const respondToPublicFlare = functions.https.onCall(
  async (data: PublicFlareResponsePayload, context) => {

    const { flareUid, isJoining } = data

    try {
      if (!context.auth) throw errorReport("Authentication Needed")
      const uid = context.auth.uid;
      if (isOnlyWhitespace(flareUid)) throw errorReport('Invalid broadcast uid');

      const flareInfo = await shortPubFlareCol.doc(flareUid).get()
      if (!flareInfo.exists) throw errorReport('This broadcast doesn\'t exist.');

      const responderSnippetSnapshot = await database.ref(`userSnippets/${uid}`).once('value');
      if (!responderSnippetSnapshot.exists()) throw errorReport(`Your account isn't set up yet`);
      const responderSnippet = responderSnippetSnapshot.val()

      const responderDocInFlareCol = await publicFlaresCol.doc(flareUid).collection("responders").doc(uid).get()
      if (isJoining) {
        if (responderDocInFlareCol.exists) throw errorReport('You are already a part of this flare!');
      } else {
        if (!responderDocInFlareCol.exists) throw errorReport('You never joined this flare');
      }

      const rtdbAdditions: Record<string, any> = {}
      const promises: Array<Promise<any>> = []


      const chatPath = `/publicFlareChats/${flareUid}/`
      const chatId = (await database.ref(chatPath).push()).key
      const chatMessage = { _id: chatId, createdAt: Date.now(), system: true } as any
      chatMessage.text = `${responderSnippet.displayName} (@${responderSnippet.username}) is ${isJoining ? "in" : "out"}!`
      rtdbAdditions[chatPath + chatId] = chatMessage
      promises.push(database.ref().update(rtdbAdditions));

      if (isJoining) {
        const snippet = { ...responderSnippet, flareOwner: flareInfo.data()?.owner.uid } //flareOwner useful for fcmBroadcastResponsePublicFlare cloud function
        promises.push(publicFlaresCol.doc(flareUid).collection("responders").doc(uid).set(snippet))
        promises.push(publicFlaresCol.doc(flareUid).update({
          totalConfirmations: admin.firestore.FieldValue.increment(1),
          responders: admin.firestore.FieldValue.arrayUnion(uid)
        }))
      } else {
        promises.push(publicFlaresCol.doc(flareUid).collection("responders").doc(uid).delete())
        promises.push(publicFlaresCol.doc(flareUid).update({
          totalConfirmations: admin.firestore.FieldValue.increment(-1),
          responders: admin.firestore.FieldValue.arrayRemove(uid)
        }))
      }

      await Promise.all(promises)
      return successReport()
    } catch (err) {
      return handleError(err)
    }
  })
