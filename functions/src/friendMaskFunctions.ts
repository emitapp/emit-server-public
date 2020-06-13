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

export const createOrEditMask = functions.https.onCall(
  async (data : maskEditRequest, context) => {

  if (!context.auth) {
      throw notSignedInError()
  }

  if (!data.maskUid && (!data.newName || isOnlyWhitespace(data.newName))){
    throw new functions.https.HttpsError(
      'invalid-argument', "No/invalid name for mask")
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