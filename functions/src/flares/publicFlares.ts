//Things we gotta do
//analytics
//icing:locking
//icing: which people to notify about this public flare
//icing: notify responders when flare has been edited or deleted

import * as functions from 'firebase-functions';
import { geohashForLocation } from 'geofire-common';
import { UserSnippet } from '../accountManagementFunctions';
import { enqueueTask, runTask, cancelTask } from '../utils/cloudTasks';
import { errorReport, handleError, isFunctionExecutionReport, isOnlyWhitespace, successReport, truncate } from '../utils/utilities';
import * as common from './common';
import { FlareDays } from './common';
import { publicFlareUserMetadataPrivateInterface } from './publicFlareUserMetadata';
import admin = require('firebase-admin');
import { hashOrgoNameForFirestore } from '../utils/strings';

interface PublicFlareCreationRequest {
  ownerUid: string,

  activity: string,
  emoji: string,
  startingTime: number, //Eg: In 5 minutes vs at 12:35am
  startingTimeRelative: boolean,
  duration: number,

  location?: string,
  geolocation?: { latitude: number, longitude: number },

  tags?: string[], //Not yet implemented
  note?: string,
  maxResponders?: number, //Not yet implimented
  recurringDays: FlareDays[],

  originalFlareUid?: string // only for recurring flares or editing an existing flare
  domainLocked?: boolean
}

interface UserSnippetWithUid extends UserSnippet {
  uid: string
}


export interface ShortenedPublicFlareInformation {
  owner: UserSnippetWithUid,
  flareId: string,
  deathTimestamp: number,
  duration: number,
  startingTime: number,
  activity: string,
  emoji: string,
  location?: string,
  note?: string,
  tags?: string[],
  recurringDays: FlareDays[],
  domain?: string,
  hashedDomain: string
  geolocation: { latitude: number, longitude: number },
  geoHash?: string
}

interface FullPublicFlareInformation extends ShortenedPublicFlareInformation {
  totalConfirmations: number,
  responders: string[],
  slug: string,
  slugPrivate: boolean,
}

interface PrivatePublicFlareInformation {
  cancellationTaskPath: string,
  confirmationCap: number | null
  ownerUid: string //For convenience of deletePublicFlare
}

interface PublicFlareDeletionRequest {
  ownerUid: string,
  flareUid: string,
  domain?: string
}

interface PublicFlareDeletionTaskPayload {
  flareUid: string,
  flareSlug: string,
}

interface PublicFlareResponsePayload {
  flareUid: string,
  isJoining: boolean
}

const database = admin.database()
const firestore = admin.firestore();
const logger = functions.logger

const PUBLIC_FLARE_COL_GROUP = "public_flares"
const _publicFlaresCol = firestore.collection("publicFlares")
export const getPublicFlareCol = (orgoHash: string): FirebaseFirestore.CollectionReference<FirebaseFirestore.DocumentData> => {
  return _publicFlaresCol.doc(orgoHash).collection(PUBLIC_FLARE_COL_GROUP)
}

const SHORT_PUBLIC_FLARE_COL_GROUP = "public_flares_short"
const _shortPubFlareCol = firestore.collection("shortenedPublicFlares")
export const getShortPublicFlareCol = (orgoHash: string): FirebaseFirestore.CollectionReference<FirebaseFirestore.DocumentData> => {
  return _shortPubFlareCol.doc(orgoHash).collection(SHORT_PUBLIC_FLARE_COL_GROUP)
}

export const DEFAULT_DOMAIN_HASH = "_open_"


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
 * This function is called as a Cloud Task (for recurring flares) and merely serves as a wrapper
 * for createPublicFlareHelper()
 */
export const createPublicFlareCloudTask =
  functions.https.onRequest(async (req, res) => {
    try {
      await createPublicFlareHelper(req.body)
      res.sendStatus(200)
    } catch (error) {
      //If this failed and returned a non-fatal report, don't retry since it probably won't
      //work later on either.
      //TODO: Consider (https://cloud.google.com/tasks/docs/creating-http-target-tasks) to
      //let it try a couple more times 
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
        const hash = data.domain ? hashOrgoNameForFirestore(data.domain) : DEFAULT_DOMAIN_HASH
        const flarePrivateDoc = await getPublicFlareCol(hash).doc(data.flareUid).collection("private").doc("private").get()
        const privateData = flarePrivateDoc.data() as (PrivatePublicFlareInformation | undefined)
        if (!privateData) throw errorReport("Failed to fetch flare private data")

        if (context.auth.uid != privateData.ownerUid) throw errorReport("You don't own this flare")
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


  if (!data.duration) throw errorReport("Invalid duration");
  if (!data.emoji || !data.activity) throw errorReport(`Invalid activity or emoji`);

  let absoluteStartingTime = 0; //In milliseconds
  if (data.startingTimeRelative) absoluteStartingTime += Date.now() + data.startingTime;
  //If the flare was set to start "in the past" for any reason, it starts now
  else if (data.startingTime < Date.now()) absoluteStartingTime = Date.now();
  else absoluteStartingTime = data.startingTime;

  const deathTime = absoluteStartingTime + data.duration;

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

  let domain = ""
  let hashedDomain = DEFAULT_DOMAIN_HASH
  if (data.domainLocked) {
    //Get the user's domain and let that inform where we put the flare
    const userExtraInfoDoc = await firestore.doc(`publicFlareUserMetadataPrivate/${data.ownerUid}`).get()
    if (!userExtraInfoDoc.exists) throw errorReport("User not associated with domain.")
    const extraInfo = userExtraInfoDoc.data() as publicFlareUserMetadataPrivateInterface
    if (!extraInfo.hashedDomain) throw errorReport("User not associated with a domain.")
    domain = extraInfo.domain as string
    hashedDomain = extraInfo.hashedDomain
  }

  const specificPublicFlaresCol = getPublicFlareCol(hashedDomain)
  const specificShortPubFlareCol = getShortPublicFlareCol(hashedDomain)

  if (isEditing) {
    console.log(hashedDomain)
    const existingFlareDoc = await specificPublicFlaresCol.doc(data.originalFlareUid as string).get()
    if (!existingFlareDoc.data()) throw errorReport("There is no flare to edit")
    existingFlareObject = existingFlareDoc.data() as FullPublicFlareInformation | undefined
    if (existingFlareObject?.owner.uid != data.ownerUid) throw errorReport("You don't own this flare.")

    const flarePrivateDoc = await specificPublicFlaresCol.doc(data.originalFlareUid as string).collection("private").doc("private").get()
    if (!flarePrivateDoc.data()) throw errorReport("Could not get privare flare information of to-be-edited flare")
    oldCancellationTaskPath = flarePrivateDoc.data()?.cancellationTaskPath
  }

  const flareUid = isEditing ? data.originalFlareUid : specificPublicFlaresCol.doc().id

  if (!flareUid) throw errorReport(`Invalid FlareUid`)

  const ownerSnippetSnapshot = await database.ref(`userSnippets/${data.ownerUid}`).once('value');
  if (!ownerSnippetSnapshot.exists()) {
    throw errorReport(`Owner snapshot missing - your account isn't set up yet`);
  }

  // *This check (and others) will no longer be needed once tags are implemented
  if (!data.geolocation) throw errorReport("No geolocation on flare!")

  //Making the full and the shortened flare docs

  //Making the object that will actually be in people's feeds
  const shortenedFlareObject: ShortenedPublicFlareInformation = {
    owner: { uid: data.ownerUid, ...ownerSnippetSnapshot.val() },
    flareId: flareUid,
    deathTimestamp: deathTime,
    duration: data.duration,
    startingTime: absoluteStartingTime,
    activity: data.activity,
    emoji: data.emoji,
    ...(data.location ? { location: data.location } : {}),
    ...(data.note ? { note: truncate(data.note, 50) } : {}),
    ...(data.tags ? { tags: data.tags } : {}),
    recurringDays: data.recurringDays,
    ...(domain ? { domain } : {}),
    hashedDomain,
    geolocation: data.geolocation,
    geoHash: geohashForLocation([data.geolocation.latitude, data.geolocation.longitude])
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
  const fullFlareObject: FullPublicFlareInformation = {
    ...shortenedFlareObject,
    ...(data.note ? { note: data.note } : {}),
    ...(data.maxResponders ? { maxResponders: data.maxResponders } : {}),
    totalConfirmations: 0,
    responders: [], //FIXME: is this a good idea? not sure
    slug: flareSlug,
    slugPrivate: false,
  }

  //Enqueueing the deletion task
  const payload: PublicFlareDeletionTaskPayload = { flareUid, flareSlug }
  const response = await enqueueTask(common.TASKS_QUEUE, "autoPublicFlareDeletion", payload, deathTime)


  const privateFlareInformation : PrivatePublicFlareInformation = {
    cancellationTaskPath: response.name,
    confirmationCap: data.maxResponders || null,
    ownerUid: data.ownerUid 
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
  promises.push(specificPublicFlaresCol.doc(flareUid).set(fullFlareObject))
  promises.push(specificShortPubFlareCol.doc(flareUid).set(shortenedFlareObject))
  promises.push(specificPublicFlaresCol.doc(flareUid).collection("private").doc("private").set(privateFlareInformation))
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

      const fullFlareDocQuery = await firestore.collectionGroup(PUBLIC_FLARE_COL_GROUP)
        .where('flareId', '==', flareUid).get();
      const shortenedFlareDocQuery = await firestore.collectionGroup(SHORT_PUBLIC_FLARE_COL_GROUP)
        .where('flareId', '==', flareUid).get();

      if (fullFlareDocQuery.empty || shortenedFlareDocQuery.empty) {
        logger.warn("autoPublicFlareDeletion called on flare that does not exist")
        return;
      }

      const fullFlareDoc = fullFlareDocQuery.docs[0]
      const fullDocData = fullFlareDoc.data() as FullPublicFlareInformation
      const shortenedFlareDoc = shortenedFlareDocQuery.docs[0]

      promises.push(shortenedFlareDoc.ref.delete())
      promises.push(fullFlareDoc.ref.delete())
      promises.push(fullFlareDoc.ref.collection("private").doc("private").delete())

      //Deleting the responders
      const responders = await fullFlareDoc.ref.collection("responders").get()
      responders.forEach(doc => promises.push(doc.ref.delete()))

      //Deleting the data stored on RTBD
      rtdbDeletions[`flareSlugs/${flareSlug}`] = null
      rtdbDeletions[`publicFlareChats/${fullDocData.hashedDomain}/${flareUid}`] = null
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

      //Getting the flare collections
      const fullFlareDocQuery = await firestore.collectionGroup(PUBLIC_FLARE_COL_GROUP).where('flareId', '==', flareUid).get();
      if (fullFlareDocQuery.empty) throw errorReport(`Flare doesn't exist!`);
      const fullFlareDoc = fullFlareDocQuery.docs[0]
      const fullFlareDocData = fullFlareDoc.data() as FullPublicFlareInformation

      //Getting user snippet
      const responderSnippetSnapshot = await database.ref(`userSnippets/${uid}`).once('value');
      if (!responderSnippetSnapshot.exists()) throw errorReport(`Your account isn't set up yet`);
      const responderSnippet = responderSnippetSnapshot.val()

      //Making sure we're not setting a response that makes no sense
      const responderDocInFlareCol = await fullFlareDoc.ref.collection("responders").doc(uid).get()
      if (isJoining) {
        if (responderDocInFlareCol.exists) throw errorReport('You are already a part of this flare!');
      } else {
        if (!responderDocInFlareCol.exists) throw errorReport('You never joined this flare');
      }

      const rtdbAdditions: Record<string, any> = {}
      const promises: Array<Promise<any>> = []

      //Adding to the chat
      const flareInfo = fullFlareDoc.data()
      const chatPath = `/publicFlareChats/${fullFlareDocData.hashedDomain}/${flareUid}/`
      const chatId = (await database.ref(chatPath).push()).key
      const chatMessage = { _id: chatId, createdAt: Date.now(), system: true } as any
      chatMessage.text = `${responderSnippet.displayName} (@${responderSnippet.username}) is ${isJoining ? "in" : "out"}!`
      rtdbAdditions[chatPath + chatId] = chatMessage
      promises.push(database.ref().update(rtdbAdditions));

      if (isJoining) {
        const snippet = { ...responderSnippet, flareOwner: flareInfo?.owner.uid } //flareOwner useful for fcmBroadcastResponsePublicFlare cloud function
        promises.push(fullFlareDoc.ref.collection("responders").doc(uid).set(snippet))
        promises.push(fullFlareDoc.ref.update({
          totalConfirmations: admin.firestore.FieldValue.increment(1),
          responders: admin.firestore.FieldValue.arrayUnion(uid)
        }))
      } else {
        promises.push(fullFlareDoc.ref.collection("responders").doc(uid).delete())
        promises.push(fullFlareDoc.ref.update({
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