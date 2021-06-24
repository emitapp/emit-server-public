/*
Note about the design concering how user avatars and user profiles work
Avatars were added in a rush beucause we had to squeeze them into our development feature queue
So that means we had to make some sacrifices due to time
It was initially planned that have a directory in RTDB that contains either an avatar 
seed or a picture url for the client to check. So, the client would only have to check once.
Problem, you can't cleanly make persistent urls for files using just server side logic:
https://stackoverflow.com/questions/42956250/get-download-url-from-file-uploaded-with-cloud-functions-for-firebase
Fixes for this is an ongoing conversation amongth the dev community at google and firebase

I was thinking of using the .makePublic method, but that would require a but of work to get all
alreasy exiting files compliant with this new design too.

We make some sacrifices, so for now, clients have to check for avatar seeds and picutre urls independenly
*/

import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';
import { DeleteFileResponse } from '@google-cloud/storage';
import { errorReport, successReport, handleError } from './utils/utilities'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path');

const database = admin.database()
const bucket = admin.storage().bucket()

/**
 * This function deletes a user's older profile pic (or a group's older pic)
 * after a new one is uploaded
 * It is only listeneing for pictures created by the image resizer,
 * Also, the image resizer is configured to delete the images resizes, so we don't have to worry about 
 * those.
 * https://firebase.google.com/products/extensions/storage-resize-images
 */
export const deleteOlderProfilePic = functions.storage.object().onFinalize(async (object) => {
  const picFolder = path.basename(path.dirname(object.name))
  if (picFolder !== "scaled") return;
  const allProfilepics = await bucket.getFiles({ directory: path.dirname(object.name) })
  const deletionPromises: Array<Promise<DeleteFileResponse>> = []
  allProfilepics[0].forEach((file) => {
    if (file.name !== object.name)
      deletionPromises.push(bucket.file(file.name).delete())
  });
  await Promise.all(deletionPromises)
});

export const chooseAvatarSeed = functions.https.onCall(
  async (seed: string, context) => {
    try {
      if (!context.auth) {
        throw errorReport("Authentication Needed")
      }

      //We don't have to waste time checking the actual seed since the 
      //client side library has checks for that
      //its good enough to check if its 12 characters long or not
      if (typeof seed != "string" || seed.length != 12){
        throw errorReport("Invalid Seed")
      }

      await Promise.all([
        deletePicFileOwnedByUid(context.auth.uid),
        database.ref(`profilePicInfo/${context.auth.uid}`).set(seed)
      ])
      return successReport()
    } catch (err) {
      return handleError(err)
    }
  });


export interface ProfilePicPaths {
  pictureFileDirectory: string,
  avatarSeed: string,
}
export const getProfilePicPaths = async (userUid: string): Promise<ProfilePicPaths> => {
  const paths: ProfilePicPaths = { 
    pictureFileDirectory: `profilePictures/${userUid}`,
    avatarSeed: `profilePicInfo/${userUid}`,
  }
  return paths
}

//Since uids are unique throughout a project, we can delete from both the profile pic
//and group profile pic directories
export const deletePicFileOwnedByUid = async (picOwnerUid: string) : Promise<any> => {
  await Promise.all([
    bucket.deleteFiles({ prefix: `groupPictures/${picOwnerUid}` }),
    bucket.deleteFiles({ prefix: `profilePictures/${picOwnerUid}` })
  ])
}