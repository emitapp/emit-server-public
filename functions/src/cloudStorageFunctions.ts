import admin = require('firebase-admin');
import * as functions from 'firebase-functions';
const path = require('path');


//I'll be keeping track of this so that this function only really does something
//when the image ends in the extension that it gets when it's resized.
//Sure, this can be easily bypassed, but it will save a lot of computation 
//for most cases
const EXPECTED_EXTENSION = "_100x100"

export const setUserProfilePicURL = functions.storage.object().onFinalize(async (object) => {
    if (!object.name?.endsWith(EXPECTED_EXTENSION)) return;
    const ownerUid = path.basename(path.dirname(object.name))

    const ownerSnippetSnapshot = await admin.database().ref(`userSnippets/${ownerUid}`).once('value');
    if (!ownerSnippetSnapshot.exists()) return; //Don't bother deleting the picture, that'll be handled by a cleanup later
    await admin.database().ref(`userSnippets/${ownerUid}/profilePicPath`).set(object.name)
});