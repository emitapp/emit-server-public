import * as functions from 'firebase-functions';
import admin = require('firebase-admin');
import {isOnlyWhitespace, errorReport, successReport, handleError} from './utilities'
import {getAllActiveBroadcastPaths, activeBroadcastPaths} from './activeBroadcastFunctions'
import {getCloudStoragePaths, CloudStoragePaths} from './cloudStorageFunctions'
import {getFCMRelatedPaths, FCMRelatedPaths} from './fcmFunctions'
import {getAllMaskRelatedPaths, MaskRelatedPaths} from './friendMaskFunctions'
import {getAllFriendshipRelatedPaths, FriendshipRelatedPaths} from './friendRequestFunctions'
import {getAllGroupPaths, GroupsPaths} from './userGroupFunctions'

export const MAX_USERNAME_LENGTH = 30
export const MAX_DISPLAY_NAME_LENGTH = 35

const database = admin.database()
const firestore = admin.firestore();
const fcmDataRef = firestore.collection("fcmData")

interface snippetCreationRequest{
    displayName:string,
    username:string
}

export interface NotificationSettings {
    onBroadcastFrom: Array<string>,
    onNewBroadcastResponse: boolean,
    onNewFriend: boolean,
    onNewFriendRequest: boolean,
    onAddedToGroup: boolean
}

export const createSnippet = functions.https.onCall(
    async (data : snippetCreationRequest, context) => {
    try{
        if (!context.auth) {
            throw errorReport("Authentication Needed")
        }
      
        if (typeof data.displayName !== "string" || typeof data.username !== "string"){
            throw errorReport("Both arguments should be strings")
        }
    
        //The Username string can only have a-z, 0-9 or _ or -
        //Display names can be whatever the user wants them to be
        const regexTest = RegExp(/^[a-z0-9_-]+$/)
    
        const normalizedDisplayName = data.displayName.normalize("NFKC")
        const normalizedUsername = data.username.normalize('NFKC') 
        const lowerNormalisedUsername = normalizedUsername.toLowerCase()
        const lowerNormalisedDisplayName= normalizedDisplayName.toLowerCase()
    
        if (isOnlyWhitespace(normalizedDisplayName) || normalizedDisplayName.length > MAX_DISPLAY_NAME_LENGTH){
            throw errorReport("Invalid display name")
        }
    
        if (lowerNormalisedUsername.length === 0 || lowerNormalisedUsername.length > MAX_USERNAME_LENGTH){
            throw errorReport("Username either too long or too short")
        }
    
        if (!regexTest.test(lowerNormalisedUsername)){
            throw errorReport("Only A-Z, a-z, 0-9 or _ or - allowed for username")
        }
    
        //Making sure the snippet doesn't already exist
        const snippetRef = database.ref(`/userSnippets/${context.auth.uid}`);
    
        if ((await snippetRef.once('value')).exists()){
            throw errorReport("Snippet already exists")
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
                throw errorReport("Username already in use!")
            }
        });

        await fcmDataRef.doc(context.auth.uid).set({
            notificationPrefs:{
                onBroadcastFrom: [],
                onNewBroadcastResponse: true,
                onNewFriend: true,
                onNewFriendRequest: true,
                onAddedToGroup: true
            },
            tokens: []
        });

        await snippetRef.set({
            username: normalizedUsername,
            usernameQuery: lowerNormalisedUsername,
            displayName: normalizedDisplayName,
            displayNameQuery: lowerNormalisedDisplayName
        }) 
        return successReport()    
    }catch(err){
        return handleError(err);
    }  
});

export const updateDisplayName = functions.https.onCall(
    async (data : string, context) => {
    try{
        if (!context.auth) {
            throw errorReport("Authentication needed")
        }
      
        if (typeof data !== "string"){
            throw errorReport("Arguments should be a string")
        }
    
        if (isOnlyWhitespace(data)){
            throw errorReport("Display name is empty or has only whitespace")
        }
    
        if (data.length > MAX_DISPLAY_NAME_LENGTH){
            throw errorReport("Display name too long")
        }
    
        const normalizedDisplayName = data.normalize("NFKC")
        const lowerNormalisedDisplayName = normalizedDisplayName.toLowerCase()
    
        const updates = {} as any
        updates[`/userSnippets/${context.auth?.uid}/displayName`] = normalizedDisplayName
        updates[`/userSnippets/${context.auth?.uid}/displayNameQuery`] = lowerNormalisedDisplayName
        await database.ref().update(updates);
        return successReport()
    }catch(err){
        return handleError(err)
    }  
});

export const updateNotificationPrefs = functions.https.onCall(
    async (data : NotificationSettings, context) => {
    try{
        if (!context.auth) {
            throw errorReport("Authentication needed")
        }
           
        if (typeof data.onAddedToGroup !== 'boolean'
            || typeof data.onNewBroadcastResponse !== 'boolean'
            || typeof data.onNewFriend !== 'boolean'
            || typeof data.onNewFriendRequest !== 'boolean'){
            throw errorReport("Invalid Arguments")
        }

        if (data.onBroadcastFrom instanceof Array) {
            data.onBroadcastFrom.forEach(uid =>
            {
               if(typeof uid !== 'string' || uid.length > 50){
                throw errorReport("Invalid Arguments")
               }
            })
         }else{
            throw errorReport("Invalid Arguments")
         }

        await fcmDataRef.doc(context.auth.uid).update({
            notificationPrefs:{
                onBroadcastFrom: data.onBroadcastFrom,
                onNewBroadcastResponse: data.onNewBroadcastResponse,
                onNewFriend: data.onNewFriend,
                onNewFriendRequest: data.onNewFriendRequest,
                onAddedToGroup: data.onAddedToGroup
            }
        });
        return successReport()
    }catch(err){
        return handleError(err)
    }  
});

//Gets all the paths that point to data relating to a user
export const getAllPaths  = async (userUid : string) : Promise<allPathsContainer> => {
    const allPaths = {} as any
    const promises = [] as Array<Promise<any>>
    allPaths.savedLocationsPath = `savedLocations/${userUid}`
    allPaths.userSnippetExtrasPath = `userSnippetExtras/${userUid}`
    promises.push((async () => {
        const userSnippet = (await database.ref(`userSnippets/${userUid}`).once('value')).val()
        allPaths.userSnippetPath = `userSnippets/${userUid}`
        allPaths.usernamePath = userSnippet ? `usernames/${userSnippet.usernameQuery}` : null
    })())
    promises.push(getAllActiveBroadcastPaths(userUid).then(paths => allPaths.activeBroadcastPaths = paths))
    promises.push(getAllFriendshipRelatedPaths(userUid).then(paths => allPaths.friendshipPaths = paths))
    promises.push(getAllGroupPaths(userUid).then(paths => allPaths.groupPaths = paths))
    promises.push(getAllMaskRelatedPaths(userUid).then(paths => allPaths.maskPaths = paths))
    promises.push(getCloudStoragePaths(userUid).then(paths => allPaths.cloudStoragePaths = paths))
    promises.push(getFCMRelatedPaths(userUid).then(paths => allPaths.fcmRelatedPaths = paths))
    await Promise.all(promises)
    return allPaths as allPathsContainer
}

interface allPathsContainer {
    userSnippetPath: string,
    usernamePath: string,
    savedLocationsPath: string,
    userSnippetExtrasPath: string,
    activeBroadcastPaths: activeBroadcastPaths,
    friendshipPaths: FriendshipRelatedPaths,
    groupPaths: GroupsPaths,
    maskPaths: MaskRelatedPaths,
    cloudStoragePaths: CloudStoragePaths,
    fcmRelatedPaths: FCMRelatedPaths,
}

export const requestAllData = functions.https.onCall(
    async (_, context) => {
    try{
        if (!context.auth) {
            throw errorReport("Authentication needed")
        }
      
        let username = "<Username not provided>"
        let displayName = "<Display name not provided>"
        let userEmail: string | undefined = ""
    
        const allPaths = await getAllPaths(context.auth.uid)
        const userData = {} as any
        const promises = [] as Array<Promise<any>>
        const retrievalPromise = async (path: string) => {
            if (!path) return;
            let data = (await database.ref(path).once("value")).val()
            if (data === null) data = "null"
            userData[path] = data
        }
        const pushPath = (p: string) => promises.push(retrievalPromise(p))
    
        pushPath(allPaths.activeBroadcastPaths.activeBroadcastSection)
        allPaths.activeBroadcastPaths.broadcastResponseSnippets.forEach(path => pushPath(path));
        allPaths.activeBroadcastPaths.broadcastResponseUids.forEach(path => pushPath(path));
        allPaths.activeBroadcastPaths.broadcastsFeedPaths.forEach(path => pushPath(path))
        pushPath(allPaths.activeBroadcastPaths.userFeed)
    
        pushPath(allPaths.friendshipPaths.requestMailbox)
        allPaths.friendshipPaths.friendshipSections.forEach(path => pushPath(path))
        allPaths.friendshipPaths.receivedFriendRequests.forEach(path => pushPath(path))
        allPaths.friendshipPaths.sentFriendRequests.forEach(path => pushPath(path))
        allPaths.friendshipPaths.snippetsInOthersFriendSections.forEach(path => pushPath(path))
        allPaths.friendshipPaths.uidsInOthersFriendSections.forEach(path => pushPath(path))
    
        pushPath(allPaths.groupPaths.groupMembershipSection)
        allPaths.groupPaths.snippetsInGroups.forEach(path => pushPath(path))
        allPaths.groupPaths.uidsInGroups.forEach(path => pushPath(path))
    
        allPaths.maskPaths.maskMembershipRecords.forEach(path => pushPath(path))
        allPaths.maskPaths.maskSections.forEach(path => pushPath(path))
        allPaths.maskPaths.snippetsInOtherMasks.forEach(path => pushPath(path))
        allPaths.maskPaths.uidsInOtherMasks.forEach(path => pushPath(path))
    
        pushPath(allPaths.usernamePath)
        pushPath(allPaths.savedLocationsPath)
        pushPath(allPaths.userSnippetExtrasPath)
    
        promises.push((async () => {
            let data = (await database.ref(allPaths.userSnippetPath).once("value")).val()
            if (data === null){
                data = "null"
            }else{
                displayName = data.displayName
                username = data.username
            }
            userData[allPaths.userSnippetPath] = data
        })())
    
        promises.push((async () => {
            const fcmTokenDoc = await firestore.doc(allPaths.fcmRelatedPaths.tokenDocumentPath).get()
            if (fcmTokenDoc.exists) userData[allPaths.fcmRelatedPaths.tokenDocumentPath] = fcmTokenDoc.data
        })())
    
        promises.push((async () => {
            const auth = admin.auth();
            const authRecord = await auth.getUser(<string>(context.auth?.uid))
            userEmail = authRecord.email
            userData["accountData"] = authRecord
        })())
       
        //At the moment we dont do anything with the profile pic path
    
        await Promise.all(promises)
    
        if (!userEmail){
            throw errorReport("No email address linked to account")
        }
    
        //Now sending a the mail to the user
        const nodemailer = await import('nodemailer');
        const transporter = nodemailer.createTransport({
            host: functions.config().env.userDataEmailing.email_host,
            port: parseInt(functions.config().env.userDataEmailing.email_port),
            secure: functions.config().env.userDataEmailing.use_tls === "true", // true for port 465, usually false for other ports
            auth: {
                   user: functions.config().env.userDataEmailing.email_address,
                   pass: functions.config().env.userDataEmailing.email_password
               }
        });
    
        let mailMessage = `<p><strong>Heya ${displayName}!&nbsp;👋👋🏾</strong></p>\n`
        mailMessage += '<p>Looks like you requested for all the personal data that Biteup has related to you.</p>\n'
        mailMessage += "<p>You'll find it attached to this email as a JSON file.</p>\n"
        mailMessage += '<p>Ciao!</p>\n\n'
        mailMessage += "<p>P.S: Don't reply to this email address - it's never checked. It's only used by our servers to send user data upon request.</p>"
        const mailOptions = {
            from: functions.config().env.userDataEmailing.email_address, 
            to: userEmail, 
            subject: `Your Biteup user data (@${username})`, 
            html: mailMessage,
            attachments: [
                {
                    filename: 'biteup_user_data.json',
                    content: JSON.stringify(userData)
                }
            ]
        };
    
        await transporter.sendMail(mailOptions)
        return successReport() 
    }catch(err){
        return handleError(err)
    }
});

export const deleteUserData = functions.auth.user().onDelete(async (user) => {
    const allPaths = await getAllPaths(user.uid)
    const updates = {} as any
    const promises = [] as Array<Promise<any>>
    const addToDeletionList = async (path: string) => {
        if (!path) return;
        updates[path] = null
    }
    const pushPath = (p: string) => promises.push(addToDeletionList(p))

    pushPath(allPaths.activeBroadcastPaths.activeBroadcastSection)
    allPaths.activeBroadcastPaths.broadcastResponseSnippets.forEach(path => pushPath(path));
    allPaths.activeBroadcastPaths.broadcastResponseUids.forEach(path => pushPath(path));
    allPaths.activeBroadcastPaths.broadcastsFeedPaths.forEach(path => pushPath(path))
    pushPath(allPaths.activeBroadcastPaths.userFeed)

    pushPath(allPaths.friendshipPaths.requestMailbox)
    allPaths.friendshipPaths.friendshipSections.forEach(path => pushPath(path))
    allPaths.friendshipPaths.receivedFriendRequests.forEach(path => pushPath(path))
    allPaths.friendshipPaths.sentFriendRequests.forEach(path => pushPath(path))
    allPaths.friendshipPaths.snippetsInOthersFriendSections.forEach(path => pushPath(path))
    allPaths.friendshipPaths.uidsInOthersFriendSections.forEach(path => pushPath(path))

    pushPath(allPaths.groupPaths.groupMembershipSection)
    allPaths.groupPaths.snippetsInGroups.forEach(path => pushPath(path))
    allPaths.groupPaths.uidsInGroups.forEach(path => pushPath(path))

    allPaths.maskPaths.maskMembershipRecords.forEach(path => pushPath(path))
    allPaths.maskPaths.maskSections.forEach(path => pushPath(path))
    allPaths.maskPaths.snippetsInOtherMasks.forEach(path => pushPath(path))
    allPaths.maskPaths.uidsInOtherMasks.forEach(path => pushPath(path))

    pushPath(allPaths.usernamePath)
    pushPath(allPaths.savedLocationsPath)
    pushPath(allPaths.userSnippetExtrasPath)
    pushPath(allPaths.userSnippetPath)

    promises.push((async () => {
        await firestore.doc(allPaths.fcmRelatedPaths.tokenDocumentPath).delete()
    })())
   
    promises.push((async () => {
        const bucket = admin.storage().bucket();
        await bucket.deleteFiles({prefix: allPaths.cloudStoragePaths.profilePictureDirectory})
    })())

    await Promise.all(promises)
    await database.ref().update(updates);
});