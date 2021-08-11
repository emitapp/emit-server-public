import * as functions from 'firebase-functions';
import admin = require('firebase-admin');
import {isOnlyWhitespace, errorReport, successReport, handleError} from './utils/utilities'
import {getAllActiveBroadcastPaths, activeBroadcastPaths} from './flares/privateFlares'
import {deletePicFileOwnedByUid, getProfilePicPaths, ProfilePicPaths} from './profilePictureFunctions'
import {getFCMRelatedPaths, FCMRelatedPaths} from './fcmFunctions/fcmCore'
import {getAllMaskRelatedPaths, MaskRelatedPaths} from './friendMaskFunctions'
import {getAllFriendshipRelatedPaths, FriendshipRelatedPaths} from './friendRequestFunctions'
import {getAllGroupPaths, GroupsPaths} from './userGroupFunctions'
import { parsePhoneNumberFromString } from 'libphonenumber-js'
import { queryRecDocsRelatedToUser, queryRecDocsContainingUser } from './friendRecommendations';
import * as defaults from './fcmFunctions/defaults'
import { getLocationDataPaths, LocationDataPaths } from './userLocationFunctions';
import { deleteAllRecurringFlaresForUser } from './flares/common';
import { envVariables } from './utils/env/envVariables';
import { EmailVerificationPaths, ExtraUserInfoPaths, getEmailVerificationPaths, getExtraUserInfoPaths } from './emailVerification';


export const MAX_USERNAME_LENGTH = 30
export const MAX_DISPLAY_NAME_LENGTH = 35

const database = admin.database()
const firestore = admin.firestore();
const fcmDataRef = firestore.collection("fcmData")
const userMetadata = firestore.collection("userMetadata")

interface snippetCreationRequest{
    displayName:string,
    username:string,
    telephone?:string
}

export interface UserSnippet {
    username: string,
    usernameQuery: string,
    displayName: string,
    displayNameQuery: string
}

export interface NotificationSettings {
    onBroadcastFrom: Array<string>,
    onNewBroadcastResponse: boolean,
    onNewFriend: boolean,
    onNewFriendRequest: boolean,
    onAddedToGroup: boolean,
    onChat: boolean,
    onNearbyPublicFlare: boolean
}

export interface AddFlareNotifRequest {
    onBroadcastFrom: string, //sender uid
    addUser: boolean //true of the user should be added, false if should be removed
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

        //Mkaing sure phone number (if there) is valid
        let phoneNumberLocal = ""
        let phoneNumberInternational = ""
        let phoneNumberCountry = ""
        if (data.telephone){
            const parsedPhoneNumber = parsePhoneNumberFromString(data.telephone, {extract: false, defaultCountry: "US"})
            if (!parsedPhoneNumber) throw errorReport("Invalid Phone number")
            phoneNumberLocal = parsedPhoneNumber.format("NATIONAL")
            phoneNumberInternational = parsedPhoneNumber.format("INTERNATIONAL")
            phoneNumberCountry = parsedPhoneNumber.country || ""
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

        const promises = [] as Array<Promise<any>>
        const notificationPrefs : NotificationSettings = {
            onBroadcastFrom: defaults.DEFAULT_FLARE_SUBSCRIPTION_LIST,
            onNewBroadcastResponse: defaults.DEFUALT_ON_FLARE_RESPONSE_FCM_PREF,
            onNewFriend: defaults.DEFUALT_ON_NEW_FRIEND_FCM_PREF,
            onNewFriendRequest: defaults.DEFUALT_ON_FRIEND_REQ_FCM_PREF,
            onAddedToGroup: defaults.DEFUALT_ON_ADDED_GROUP_FCM_PREF,
            onChat: defaults.DEFUALT_ON_CHAT_FCM_PREF,
            onNearbyPublicFlare: defaults.DEFUALT_ON_NEARBY_PUBLIC_FLARE_FCM_PREF
        }

        promises.push(
            fcmDataRef.doc(context.auth.uid).set({
                notificationPrefs,
                tokens: []
            })
        );

        if (data.telephone){
            promises.push(
                userMetadata.doc(context.auth.uid).set({
                    phoneNumberInfo:{
                        phoneNumberLocal,
                        phoneNumberInternational, 
                        phoneNumberCountry
                    }
                })
            );
        }

        promises.push(
            snippetRef.set({
                username: normalizedUsername,
                usernameQuery: lowerNormalisedUsername,
                displayName: normalizedDisplayName,
                displayNameQuery: lowerNormalisedDisplayName
            }) 
        )

        await Promise.all(promises)
        return successReport()    
    }catch(err){
        return handleError(err);
    }  
});


export const updatePhoneNumber = functions.https.onCall(
    async (phoneNumber : string, context) => {
    try{
        if (!context.auth) {
            throw errorReport("Authentication needed")
        }
      
        //Mkaing sure phone number is valid
        let phoneNumberLocal = ""
        let phoneNumberInternational = ""
        let phoneNumberCountry = ""
        const parsedPhoneNumber = parsePhoneNumberFromString(phoneNumber, {extract: false, defaultCountry: "US"})
        if (!parsedPhoneNumber) throw errorReport("Invalid Phone number")
        phoneNumberLocal = parsedPhoneNumber.format("NATIONAL")
        phoneNumberInternational = parsedPhoneNumber.format("INTERNATIONAL")
        phoneNumberCountry = parsedPhoneNumber.country || ""

        await userMetadata.doc(context.auth.uid).set({
            phoneNumberInfo:{
                phoneNumberLocal,
                phoneNumberInternational, 
                phoneNumberCountry
            }
        })

        return successReport()
    }catch(err){
        return handleError(err)
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

//Subscriber subscribes to a subscribee
//Subscibee can be a user or a group
export const subscribeToFlareSender = async (subscriberUid : string, subscribeeUid : string) : Promise<void> => {
    await fcmDataRef.doc(subscriberUid).update({
        "notificationPrefs.onBroadcastFrom": admin.firestore.FieldValue.arrayUnion(subscribeeUid)
    });
}

//unsubscriber unsubscribes from an unsubscribee
//Subscibee can be a user or a group
export const unsubscribeToFlareSender = async (unsubscriberUid : string, unsubscribeeUid : string) : Promise<void> => {
    await fcmDataRef.doc(unsubscriberUid).update({
        "notificationPrefs.onBroadcastFrom": admin.firestore.FieldValue.arrayRemove(unsubscribeeUid)
    });
}

export const changeFlareSubscription = functions.https.onCall(
    async (data : AddFlareNotifRequest, context) => {
        try {
            if (!context.auth) {
                throw errorReport("Authentication needed")
            }            

            if (typeof data.onBroadcastFrom !== 'string'
            || typeof data.addUser !== 'boolean'){
                    throw errorReport("Invalid arguments")
            }

            if (data.addUser) await subscribeToFlareSender(context.auth.uid, data.onBroadcastFrom)
            else await unsubscribeToFlareSender(context.auth.uid, data.onBroadcastFrom)

            return successReport()
        } catch(err) {
        return handleError(err)
    }  
});

export const updateNotificationPrefs = functions.https.onCall(
    async (data : NotificationSettings, context) => {
    try{
        if (!context.auth) 
            throw errorReport("Authentication needed")

        if (! (data.onBroadcastFrom instanceof Array)) 
            throw errorReport("Invalid Arguments")

        data.onBroadcastFrom.forEach(uid =>
            {
                if(typeof uid !== 'string' || uid.length > 50){
                throw errorReport("Invalid Arguments: Malformed User Uid")
                }
            })

        //There should be a cleaner  way to do this but whatever
        //I'll optimize it later ._.
        if (typeof data.onNearbyPublicFlare != 'boolean') {
            if (typeof data.onNearbyPublicFlare != "undefined") throw errorReport("Bad Arguments!")
            data.onNearbyPublicFlare = defaults.DEFUALT_ON_NEARBY_PUBLIC_FLARE_FCM_PREF
        }

        if (typeof data.onAddedToGroup != 'boolean') {
            if (typeof data.onAddedToGroup != "undefined") throw errorReport("Bad Arguments!")
            data.onAddedToGroup = defaults.DEFUALT_ON_ADDED_GROUP_FCM_PREF
        }

        if (typeof data.onChat != 'boolean') {
            if (typeof data.onChat != "undefined") throw errorReport("Bad Arguments!")
            data.onChat = defaults.DEFUALT_ON_CHAT_FCM_PREF
        }

        if (typeof data.onNewFriendRequest != 'boolean') {
            if (typeof data.onNewFriendRequest != "undefined") throw errorReport("Bad Arguments!")
            data.onNewFriendRequest = defaults.DEFUALT_ON_FRIEND_REQ_FCM_PREF
        }

        if (typeof data.onNewBroadcastResponse != 'boolean') {
            if (typeof data.onNewBroadcastResponse != "undefined") throw errorReport("Bad Arguments!")
            data.onNewBroadcastResponse = defaults.DEFUALT_ON_FLARE_RESPONSE_FCM_PREF
        }

        if (typeof data.onNewFriend != 'boolean') {
            if (typeof data.onNewFriend != "undefined") throw errorReport("Bad Arguments!")
            data.onNewFriend = defaults.DEFUALT_ON_NEW_FRIEND_FCM_PREF
        }
         
        const notificationPrefs : NotificationSettings = {
            onBroadcastFrom: data.onBroadcastFrom,
            onNewBroadcastResponse: data.onNewBroadcastResponse,
            onNewFriend: data.onNewFriend,
            onNewFriendRequest: data.onNewFriendRequest,
            onAddedToGroup: data.onAddedToGroup,
            onChat: data.onChat,
            onNearbyPublicFlare: data.onNearbyPublicFlare
        }

        await fcmDataRef.doc(context.auth.uid).update({notificationPrefs})
        return successReport()
    }catch(err){
        return handleError(err)
    }  
});


interface allPathsContainer {
    recurringFlaresPath: string,
    userSnippetPath: string,
    usernamePath: string,
    savedLocationsPath: string,
    userMetadataPath: string,
    userSnippetExtrasPath: string,
    activeBroadcastPaths: activeBroadcastPaths,
    friendshipPaths: FriendshipRelatedPaths,
    groupPaths: GroupsPaths,
    maskPaths: MaskRelatedPaths,
    profilePicRelatedPaths: ProfilePicPaths,
    fcmRelatedPaths: FCMRelatedPaths,
    recDocPaths: FirebaseFirestore.Query<FirebaseFirestore.DocumentData>,
    recDocContainingUserPaths: FirebaseFirestore.Query<FirebaseFirestore.DocumentData>,
    locationDataPaths: LocationDataPaths,
    emailVerificationPaths: EmailVerificationPaths,
    extraUserInfoPaths: ExtraUserInfoPaths
}

//Gets all the paths that point to data relating to a user
export const getAllPaths  = async (userUid : string) : Promise<allPathsContainer> => {
    const allPaths = {} as Partial<allPathsContainer>
    const promises = [] as Array<Promise<any>>
    allPaths.savedLocationsPath = `savedLocations/${userUid}`
    allPaths.userSnippetExtrasPath = `userSnippetExtras/${userUid}`
    allPaths.userMetadataPath = `userMetadata/${userUid}`
    allPaths.recDocPaths = queryRecDocsRelatedToUser(userUid)
    allPaths.recDocContainingUserPaths = queryRecDocsContainingUser(userUid)
    allPaths.emailVerificationPaths = getEmailVerificationPaths(userUid)
    allPaths.extraUserInfoPaths = getExtraUserInfoPaths(userUid)

    promises.push((async () => {
        const userSnippet = (await database.ref(`userSnippets/${userUid}`).once('value')).val()
        allPaths.userSnippetPath = `userSnippets/${userUid}`
        allPaths.usernamePath = userSnippet ? `usernames/${userSnippet.usernameQuery}` : null
    })())

    promises.push(getAllActiveBroadcastPaths(userUid).then(paths => allPaths.activeBroadcastPaths = paths))
    promises.push(getAllFriendshipRelatedPaths(userUid).then(paths => allPaths.friendshipPaths = paths))
    promises.push(getAllGroupPaths(userUid).then(paths => allPaths.groupPaths = paths))
    promises.push(getAllMaskRelatedPaths(userUid).then(paths => allPaths.maskPaths = paths))
    promises.push(getProfilePicPaths(userUid).then(paths => allPaths.profilePicRelatedPaths = paths))
    promises.push(getFCMRelatedPaths(userUid).then(paths => allPaths.fcmRelatedPaths = paths))
    promises.push(getLocationDataPaths(userUid).then(paths => allPaths.locationDataPaths = paths))
    await Promise.all(promises)
    return allPaths as allPathsContainer
}

//TODO: out of date with current getAllPaths
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
            host: envVariables.userDataEmailing.email_host,
            port:envVariables.userDataEmailing.email_port,
            secure: envVariables.userDataEmailing.use_tls, // true for port 465, usually false for other ports
            auth: {
                   user: envVariables.userDataEmailing.email_address,
                   pass: envVariables.userDataEmailing.email_password
               }
        });
    
        let mailMessage = `<p><strong>Heya ${displayName}!&nbsp;👋👋🏾</strong></p>\n`
        mailMessage += '<p>Looks like you requested for all the personal data that Emit has related to you.</p>\n'
        mailMessage += "<p>You'll find it attached to this email as a JSON file.</p>\n"
        mailMessage += '<p>Ciao!</p>\n\n'
        mailMessage += "<p>P.S: Don't reply to this email address - it's never checked. It's only used by our servers to send user data upon request.</p>"
        const mailOptions = {
            from: envVariables.userDataEmailing.email_address, 
            to: userEmail, 
            subject: `Your Emit user data (@${username})`, 
            html: mailMessage,
            attachments: [
                {
                    filename: 'emit_user_data.json',
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
    pushPath(allPaths.recurringFlaresPath)

    pushPath(allPaths.locationDataPaths.locationDataPath)
    pushPath(allPaths.locationDataPaths.locationGatheringPreferencePath)


    promises.push((async () => {
        await firestore.doc(allPaths.fcmRelatedPaths.tokenDocumentPath).delete()
    })())

    promises.push((async () => {
        await firestore.doc(allPaths.userMetadataPath).delete()
    })())

    promises.push((async () => {
        await firestore.doc(allPaths.extraUserInfoPaths.extraInfoPath).delete()
    })())

    promises.push((async () => {
        await firestore.doc(allPaths.emailVerificationPaths.emailVerificationPath).delete()
    })())
   
    promises.push(deletePicFileOwnedByUid(user.uid))
    pushPath(allPaths.profilePicRelatedPaths.avatarSeed)
    
    //TODO: should probably make this a batch write or something
    const recDocs = await allPaths.recDocPaths.get()
    recDocs.docs.forEach(d => {
        promises.push(d.ref.delete())
    })

    promises.push((async () => { await deleteAllRecurringFlaresForUser(user.uid) })())

    //No need to user allPaths.recDocContainingUserPaths
    //Since those docs will me cleaned up via triggers

    await Promise.all(promises)
    await database.ref().update(updates);
});