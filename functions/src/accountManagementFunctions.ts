import * as functions from 'firebase-functions';
import * as standardHttpsData from './standardHttpsData'
import admin = require('firebase-admin');
import {isOnlyWhitespace} from './standardFunctions'

const database = admin.database()

interface snippetCreationRequest{
    displayName:string,
    username:string
}

export const createSnippet = functions.https.onCall(
    async (data : snippetCreationRequest, context) => {
    
    if (!context.auth) {
        throw standardHttpsData.notSignedInError()
    }
  
    if (typeof data.displayName !== "string" || typeof data.username !== "string"){
        throw new functions.https.HttpsError("invalid-argument", 
        "Both arguments should be strings")
    }

    //The Username string can only have a-z, 0-9 or _ or -
    //Display names can be whatever the user wants them to be
    const regexTest = RegExp(/^[a-z0-9_-]+$/)

    const normalizedDisplayName = data.displayName.normalize("NFKC")
    const normalizedUsername = data.username.normalize('NFKC') 
    const lowerNormalisedUsername = normalizedUsername.toLowerCase()
    const lowerNormalisedDisplayName= normalizedDisplayName.toLowerCase()

    if (!regexTest.test(lowerNormalisedUsername)){
        throw new functions.https.HttpsError("invalid-argument", 
        "Only A-Z, a-z, 0-9 or _ or - allowed for username")
    }

    //Making sure the snippet doesn't already exist
    const snippetRef = database.ref(`/userSnippets/${context.auth.uid}`);

    if ((await snippetRef.once('value')).exists()){
        throw new functions.https.HttpsError('failed-precondition', "Snippet already exists")
    }

    //Now checking if the username is in use already
    const usernameRef = database.ref(`/usernames/${lowerNormalisedUsername}`)

    await usernameRef.transaction(function(currentOwnerUid) {
        if (currentOwnerUid === null || currentOwnerUid === context.auth?.uid) {
            //We're also checking if she's the previous owner incase this
            //function ever fails after this transaction (becase the 
            //snippet might not be created but the username would)
            return context.auth?.uid;
        } else {
            throw new functions.https.HttpsError('failed-precondition',
                "Username already in use!")
        }
    });

    await snippetRef.set({
        username: normalizedUsername,
        usernameQuery: lowerNormalisedUsername,
        displayName: normalizedDisplayName,
        displayNameQuery: lowerNormalisedDisplayName
    }) 
});

export const updateDisplayName = functions.https.onCall(
    async (data : string, context) => {
    
    if (!context.auth) {
        throw standardHttpsData.notSignedInError()
    }
  
    if (typeof data !== "string"){
        throw new functions.https.HttpsError("invalid-argument", 
        "Arguments should be a string")
    }

    if (isOnlyWhitespace(data)){
        throw new functions.https.HttpsError("invalid-argument", 
        "Display name is empty or has only whitespace")
    }

    const normalizedDisplayName = data.normalize("NFKC")
    const lowerNormalisedDisplayName = normalizedDisplayName.toLowerCase()

    const updates = {} as any
    updates[`/userSnippets/${context.auth?.uid}/displayName`] = normalizedDisplayName
    updates[`/userSnippets/${context.auth?.uid}/displayNameQuery`] = lowerNormalisedDisplayName
    await database.ref().update(updates);
    return {status: standardHttpsData.returnStatuses.OK}
});
