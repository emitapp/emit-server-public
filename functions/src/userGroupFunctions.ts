import * as functions from 'firebase-functions';
import * as standardHttpsData from './standardHttpsData'
import admin = require('firebase-admin');
import { isEmptyObject, objectDifference } from './standardFunctions';
import { HttpsError } from 'firebase-functions/lib/providers/https';

const groupRanks = {
    STANDARD: "standard",
    ADMIN: "admin"
}

interface groupCreationRequest {
    name: string,
    usersToAdd: { [key: string]: boolean; }
}

interface groupEditRequest {
    groupUid: string,
    newName?: string,
    usersToAdd?: { [key: string]: boolean; }
    usersToRemove?: { [key: string]: boolean; }
}

const authCheck = (
    context : functions.https.CallableContext) => {
    // Checking that the user is authenticated.
    if (!context.auth) {
        throw standardHttpsData.notSignedInError()
    }
}

const database = admin.database()

/**
 * Creates a new Biteup group
 */
export const createGroup = functions.https.onCall(
    async (data : groupCreationRequest, context) => {
    
    authCheck(context)
    if (isEmptyObject(data.usersToAdd) || (data.name === "")){
        throw new HttpsError('invalid-argument', "Empty member list or invlaid group name")
    }
    let groupMasterPath = `/userGroups/`
    const groupUid = database.ref(groupMasterPath).push().key
    groupMasterPath += groupUid

    const updates = {} as any
    const snippetAdditionPromises = []
    const additionPromise = async (uid : string) => {
        const snippetSnapshot = await database.ref(`userSnippets/${uid}`).once("value")
        const rank = uid === context.auth?.uid ? groupRanks.ADMIN : groupRanks.STANDARD
        if (!snippetSnapshot.exists()) throw new Error("User doesn't exist")
        updates[`${groupMasterPath}/memberSnippets/${uid}`] = {...snippetSnapshot.val(), rank}
    }

    //The member count is handled by another cloud function
    updates[`${groupMasterPath}/snippet`] = {name: data.name}
    for (const uid of [...Object.keys(data.usersToAdd), context.auth?.uid]) {
        updates[`userGroupMemberships/${uid}/${groupUid}`] = {name: data.name}
        updates[`${groupMasterPath}/memberUids/${uid}`] = true
        snippetAdditionPromises.push(additionPromise(<string>uid))
    }

    await Promise.all(snippetAdditionPromises)
    await database.ref().update(updates);
    return {status: standardHttpsData.returnStatuses.OK}
});

/**
 * Sends a friend request to another Biteup user
 */
export const editGroup = functions.https.onCall(
    async (data : groupEditRequest, context) => {
    
    authCheck(context)
    const userRank = (await database
        .ref(`/userGroups/${data.groupUid}/userSnippets/${context.auth?.uid}/rank`)
        .once("value")).val()

    //Checking if this user is removing someone else from the group
    const isRemovingOther = (data.usersToRemove 
        && Object.keys(data.usersToRemove).length > 1
        && !data.usersToRemove[(<any>context.auth).uid])

    if (!(await database.ref(`/userGroups/${data.groupUid}/snippet/name`).once("value")).exists()){
        throw new HttpsError('invalid-argument', 'Group does not exitst');
    }else if (!userRank){
        throw new HttpsError('failed-precondition', 'Not a member of this group');
    }else if (userRank !== groupRanks.ADMIN && isRemovingOther){
        throw new HttpsError('permission-denied', 'Required admin privilidges');
    }

    
    let updates = {}
    if (data.usersToAdd) updates = {...updates, ...await addMembers(data)}
    if (data.usersToRemove) updates = {...updates, ...removeMembers(data)}
    if (data.newName) updates = {...updates, ...await updateGroupName(data)}
    await database.ref().update(updates);
    return {status: standardHttpsData.returnStatuses.OK}
});

export const deleteGroup = functions.https.onCall(
    async (data : groupEditRequest, context) => {
    
    authCheck(context)
    const userRank = (await database
        .ref(`/userGroups/${data.groupUid}/userSnippets/${context.auth?.uid}/rank`)
        .once("value")).val()

    if (!(await database.ref(`/userGroups/${data.groupUid}/snippet/name`).once("value")).exists()){
        throw new HttpsError('invalid-argument', 'Group does not exitst');
    }else if (!userRank){
        throw new HttpsError('failed-precondition', 'Not a member of this group');
    }else if (userRank !== groupRanks.ADMIN){
        throw new HttpsError('permission-denied', 'Required admin privilidges');
    }

    const currentMembers = 
        (await database.ref(`/userGroups/${data.groupUid}/memberUids`).once("value")).val()

    const updates = removeMembers({groupUid: data.groupUid, usersToRemove: currentMembers})
    await database.ref().update(updates); //Group snippet will be removed by updateGroupMemberCount 
    return {status: standardHttpsData.returnStatuses.OK}
});

export const updateGroupMemberCount = functions.database.ref('/userGroups/{groupUid}/memberUids')
    .onWrite(async (snapshot, context) => {
      const newValue = snapshot.after.val()
      const snippetRef = database.ref(`/userGroups/${context.params.groupUid}/snippet`)

      if (newValue === null){ 
        //The group itself has no more members
        //Delete the groups snippet to complete its deletion
        await snippetRef.parent?.child("snippet").remove()
        return; 
      }else{
        await snippetRef.child("memberCount").set(Object.keys(newValue).length)
      }
});

export const updateGroupAdminCount = functions.database.ref('/userGroups/{groupUid}/memberSnippets/{uid}/rank')
    .onWrite(async (snapshot, context) => {
    const oldValue = snapshot.before.val()
    const newValue = snapshot.after.val()
    const adminCountRef = database.ref(`/userGroups/${context.params.groupUid}/snippet/adminCount`)

    if (oldValue !== groupRanks.ADMIN && newValue === groupRanks.ADMIN){ 
        await adminCountRef.transaction(count => count + 1)
    }else if(oldValue === groupRanks.ADMIN && newValue !== groupRanks.ADMIN){
        await adminCountRef.transaction(count => count - 1)
    }
});

const removeMembers = (data : groupEditRequest) => {
    const updates = {} as any
    for (const uid in data.usersToRemove){
        updates[`/userGroups/${data.groupUid}/memberUids/${uid}`] = null
        updates[`/userGroups/${data.groupUid}/memberSnippets/${uid}`] = null
        updates[`userGroupMemberships/${uid}/${data.groupUid}`] = null
    }
    return updates
}

const addMembers = async (data : groupEditRequest) => {
    const updates = {} as any
    const snippetAdditionPromises = []

    const name = data.newName || 
        (await database.ref(`/userGroups/${data.groupUid}/snippet/name`).once("value")).val()
    
    const currentMembers = 
        (await database.ref(`/userGroups/${data.groupUid}/memberUids`).once("value")).val()
    
    //Making sure we don't readd people who are already in the group
    const newMembers = objectDifference(<object>data.usersToAdd, currentMembers)
    const snippetAdditionPromise = async (uid : string) => {
        const snippetSnapshot = await database.ref(`userSnippets/${uid}`).once("value")
        if (!snippetSnapshot.exists()) throw new Error("User doesn't exist")
        updates[`/userGroups/${data.groupUid}/memberSnippets/${uid}`] 
            = {...snippetSnapshot.val(), rank: groupRanks.STANDARD}
    }
    
    for (const uid of newMembers) {
        updates[`userGroupMemberships/${uid}/${data.groupUid}`] = {name}
        updates[`/userGroups/${data.groupUid}/memberUids/${uid}`] = true
        snippetAdditionPromises.push(snippetAdditionPromise(uid))
    }
    await Promise.all(snippetAdditionPromises)
    return updates
}

const updateGroupName = async (data : groupEditRequest) => {
    const updates = {} as any
    const currentMembers = 
        (await database.ref(`/userGroups/${data.groupUid}/memberUids`).once("value")).val()

    for (const uid of objectDifference(currentMembers, data.usersToRemove || {})) {
        updates[`userGroupMemberships/${uid}/${data.groupUid}`] = {name: data.newName}
    }
    updates[`/userGroups/${data.groupUid}/memberUids`] = {name: data.newName}
    return updates
}
