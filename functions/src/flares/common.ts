import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin'
import { errorReport, handleError, successReport } from '../utils/utilities';
import { cancelTask } from '../utils/cloudTasks';
import { envVariables } from '../utils/env/envVariables';
export const FLARE_LIFETIME_CAP_MINS = 2879 //48 hours - 1 minute
export const TASKS_QUEUE = envVariables.broadcastCreation.autodelete_task_queue_name
export const MAX_LOCATION_NAME_LENGTH = 200
export const MAX_BROADCAST_NOTE_LENGTH = 500
const database = admin.database()

export type FlareDays =
    "S" |
    "M" |
    "T" |
    "W" |
    "Th" |
    "F" |
    "Sat"

export const dayOfWeekMapper: { [day: string]: number; } = {
  "S": 0,
  "M": 1,
  "T": 2,
  "W": 3,
  "Th": 4,
  "F": 5,
  "Sat": 6
}

export const EPOCH_MILISECONDS_IN_A_DAY = 86400000


export interface DeleteRecurringFlareRequest {
  flareUid: string,
  ownerUid: string
}

const makeFlareSlug = (length: number): string => {
  let result = '';
  const characters = 'abcdefghijklmnopqrstuvwxyz';
  const charactersLength = characters.length;
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
  }
  return result;
}

export const getAvailableFlareSlug = async (length: number): Promise<string> => {
  const database = admin.database()
  let slug = ""
  let unique = false
  while (!unique) { //FIXME: Potential point of woes haha. 
    slug = makeFlareSlug(length)
    const uniquenessCheck = await database.ref(`flareSlugs/${slug}`).once("value");
    if (!uniquenessCheck.exists()) unique = true
  }
  return slug
}

/**
 * This function is called to delete a recurring flare
 */
export const deleteRecurringFlare =
  functions.https.onCall(async (data: DeleteRecurringFlareRequest, context) => {
    try {
      // Basic checks
      if (!context.auth) throw errorReport("Authentication Needed")
      if (context.auth.uid !== data.ownerUid) throw errorReport('Your auth token doens\'t match')
      await deleteRecurringFlareHelper(data)
      return successReport({ flareUid: data.flareUid, deleted: true })
    } catch (err) {
      return handleError(err)
    }
  });


export const deleteRecurringFlareHelper = async (data: DeleteRecurringFlareRequest) : Promise<void> => {
  const flareUid = data.flareUid
  const ownerUid = data.ownerUid
  const recurringFlarePath = `recurringFlares/${ownerUid}/${flareUid}`
  const recurringFlareSnapshot = await database.ref(recurringFlarePath).once('value');
  if (!recurringFlareSnapshot.exists()) throw errorReport(`The recurring flare you're trying to delete doesn't exist.`);

  // kill task
  const nextTaskName = recurringFlareSnapshot.val().cloudTaskName
  await cancelTask(nextTaskName)

  // remove entry from db
  const rtdbDeletions: Record<string, null> = {}
  rtdbDeletions[recurringFlarePath] = null
  await database.ref().update(rtdbDeletions)
}



export const deleteAllRecurringFlaresForUser = async (userUid: string): Promise<any> => {
  const recurringFlarePath = `recurringFlares/${userUid}/`
  const promises: Promise<void>[] = []
  const flares = (await database.ref(recurringFlarePath).once("value")).val()
  if (!flares) return
  const keys = Object.keys(flares)
  keys.forEach(flareUid => promises.push(deleteRecurringFlareHelper({flareUid, ownerUid: userUid})))
  await Promise.all(promises)
}

/**
 * Function is used to generate the next execution time of a recurring flare
 * @param recurringDays the days a user wants to repeat the flare
 * @param originalStartingTime the time the current, original flare was created in epoch miliseconds
 * @returns the next execution time in epoch miliseconds
 */
export const computeNextExecutionTime = (recurringDays: FlareDays[],
  originalStartingTime: number): number => {
  // Sorting days in array chronologically 
  // since user clicks on the front-end are unpredictable
  recurringDays.sort(function sortByDay(day1: FlareDays, day2: FlareDays) {
    return dayOfWeekMapper[day1] - dayOfWeekMapper[day2]
  });

  // calculate the next execution time
  const currentDayInt = new Date().getDay()
  let minDifferenceInDays = 7
  for (let i = 0; i < recurringDays.length; i++) {
    // exclude today from the next execution
    if (dayOfWeekMapper[recurringDays[i]] != currentDayInt) {
      let currDifference = dayOfWeekMapper[recurringDays[i]] - currentDayInt
      if (currDifference < 0) {
        currDifference += 7
      }
      minDifferenceInDays = Math.min(currDifference, minDifferenceInDays)
    }
  }
  return originalStartingTime + (minDifferenceInDays * EPOCH_MILISECONDS_IN_A_DAY)

}
