import * as functions from 'firebase-functions';
import { isOnlyWhitespace } from './standardFunctions';
import { notSignedInError, returnStatuses } from './standardHttpsData';
import admin = require('firebase-admin');

const database = admin.database()

interface maskEditRequest {
  maskUid?: string,
  newName?: string,
  usersToAdd?: { [key: string]: boolean; }
  usersToRemove?: { [key: string]: boolean; }
}

export const MAX_MASK_NAME_LENGTH = 40

export const createOrEditMask = functions.https.onCall(
  async (data : maskEditRequest, context) => {

  if (!context.auth) {
      throw notSignedInError()
  }

  if (!data.maskUid && !data.newName ){
    throw new functions.https.HttpsError(
      'invalid-argument', "No name for mask")
  }

  if (data.newName && (isOnlyWhitespace(data.newName) || data.newName.length > MAX_MASK_NAME_LENGTH)){
    throw new functions.https.HttpsError(
      'invalid-argument', "Invalid name for mask")
  }

  const maskUid = data.maskUid || database.ref(`/userFriendGroupings/${context.auth.uid}/custom/snippets`).push().key
  const maskSnippetPath = `/userFriendGroupings/${context.auth.uid}/custom/snippets/${maskUid}`
  const maskDetailsPath = `/userFriendGroupings/${context.auth.uid}/custom/details/${maskUid}`

  const updates = {} as any
  const promises = []
  const userAdditionPromise = async (uid : string) => {
    const userSnippetSnap = await database.ref(`userFriendGroupings/${context.auth?.uid}/_masterSnippets/${uid}`).once("value")
    if (!userSnippetSnap.exists()){
      throw new functions.https.HttpsError(
        "failed-precondition", "One of the people you're tring to add isn't one of your friends"
      )
    }
    updates[`${maskDetailsPath}/memberSnippets/${uid}`] = userSnippetSnap.val()
    updates[`${maskDetailsPath}/memberUids/${uid}`] = true
    updates[`/userFriendGroupings/${context.auth?.uid}/_friendMaskMemberships/${uid}/${maskUid}`] = true
  }

  if (data.newName) updates[`${maskSnippetPath}/name`] = data.newName
  for (const uid in data.usersToAdd) {
    promises.push(userAdditionPromise(uid))
  }
  for (const uid in data.usersToRemove) {
    updates[`${maskDetailsPath}/memberSnippets/${uid}`] = null
    updates[`${maskDetailsPath}/memberUids/${uid}`] = null
    updates[`/userFriendGroupings/${context.auth?.uid}/_friendMaskMemberships/${uid}/${maskUid}`] = null
  }

  await Promise.all(promises)
  await database.ref().update(updates);
  return {status: returnStatuses.OK}
});

export const deleteMask = functions.https.onCall(
  async (data : maskEditRequest, context) => {

  if (!context.auth) {
      throw notSignedInError()
  }

  if (isOnlyWhitespace(<string>data.maskUid)){
    throw new functions.https.HttpsError(
      "invalid-argument", "Invalid group uid"
    )
  }

  const snippetPath = `/userFriendGroupings/${context.auth.uid}/custom/snippets/${data.maskUid}`
  const infoPath = `/userFriendGroupings/${context.auth.uid}/custom/details/${data.maskUid}`
  const updates = {} as any
  updates[infoPath] = null
  updates[snippetPath] = null

  const memberListSnap  = await database.ref(`${infoPath}/memberUids`).once("value")
  for (const uid in memberListSnap.val()) {
    updates[`/userFriendGroupings/${context.auth?.uid}/_friendMaskMemberships/${uid}/${data.maskUid}`] = null
  }

  await database.ref().update(updates);
  return {status: returnStatuses.OK}
});

export const updateMaskMemberCount = functions.database.ref('/userFriendGroupings/{userUid}/custom/details/{maskUid}/memberUids')
  .onWrite(async (snapshot, context) => {
    const newValue = snapshot.after.val()
    const snippetRef = database.ref(`/userFriendGroupings/${context.params.userUid}/custom/snippets/${context.params.maskUid}`)

  //If this has been deleted, either the mask has no people in it or it's been deleted
    if (newValue === null){ 
      const snippetSnapshot = await snippetRef.once("value")
      if (!snippetSnapshot.exists()) return; //The mask itself has been deleted
      else await snippetRef.child("memberCount").set(0)
    }else{
      await snippetRef.child("memberCount").set(Object.keys(newValue).length)
    }
});

export interface MaskRelatedPaths {
  maskSections : Array<string>,
  snippetsInOtherMasks: Array<string>,
  uidsInOtherMasks: Array<string>,
  maskMembershipRecords: Array<string>
}

export const getAllMaskRelatedPaths = async (userUid : string) : Promise<MaskRelatedPaths> => {
  const paths : MaskRelatedPaths = {
      maskSections : [],
      snippetsInOtherMasks: [],
      uidsInOtherMasks: [],
      maskMembershipRecords: []
  }
  // 1) Getting the paths for the masks you manage
  paths.maskSections.push(`/userFriendGroupings/${userUid}/_friendMaskMemberships`)
  paths.maskSections.push(`/userFriendGroupings/${userUid}/custom`)

  // 2) Paths pointing to information about you in other masks
  //First, get all yout friends uids...
  const getMaskPaths = async (friendUid:string) => {
    const membershipListSnapshot = 
      await database.ref(`/userFriendGroupings/${friendUid}/_friendMaskMemberships/${userUid}`)
      .once("value")
      if (membershipListSnapshot.exists()){
        paths.maskMembershipRecords.push(`/userFriendGroupings/${friendUid}/_friendMaskMemberships/${userUid}`)
        for (const maskUid in membershipListSnapshot.val()) {
          paths.snippetsInOtherMasks.push(`/userFriendGroupings/${friendUid}/custom/details/${maskUid}/memberSnippets/${userUid}`)
          paths.snippetsInOtherMasks.push(`/userFriendGroupings/${friendUid}/custom/details/${maskUid}/memberUids/${userUid}`)
        }
      }
  }

  const allFriendsUids = (await database.ref(`/userFriendGroupings/${userUid}/_masterUIDs`).once("value")).val()
  const pathRetrievalPaths = []
  for (const friendUid in allFriendsUids) {
    pathRetrievalPaths.push(getMaskPaths(friendUid))
  }
  await Promise.all(pathRetrievalPaths)
  return paths
}