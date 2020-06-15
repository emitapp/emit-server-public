//The methods here make use of leases to mkae sure that edits are ordered
//and that many people aren't editing the same group at the same time.
//These were needed because functions and triggers can't enforce order on their own

import * as functions from 'firebase-functions';
import {returnStatuses, leaseStatus, notSignedInError} from './standardHttpsData'
import admin = require('firebase-admin');
import { isEmptyObject, objectDifference, isOnlyWhitespace, isNullOrUndefined, randomKey } from './standardFunctions';

enum groupRanks {
    STANDARD = "standard",
    ADMIN = "admin"
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
    usersToPromote?: { [key: string]: boolean; },
    usersToDemote?: { [key: string]: boolean; }
}

const database = admin.database()

/**
 * Checking that the user is authenticated.
 */
const authCheck = (context : functions.https.CallableContext) => {
    if (!context.auth) {
        throw notSignedInError()
    }
}

/**
 * Check the availability of a lease for a group.
 * (Claims it for 10s if it's available)
 * Essentially acts like a time-based mutex
 */
const claimGroupLease = async (groupUid: string) : Promise<leaseStatus> => {
    let status : leaseStatus = leaseStatus.NONEXISTENT
    await database.ref(`/userGroups/${groupUid}/snippet/leaseTime`).transaction(leaseTime => {
        if (leaseStatus === null){
            return; //Do nothing
        }
        else if (leaseTime > Date.now()){
            status = leaseStatus.TAKEN
            return; 
        }else{
            status = leaseStatus.AVAILABLE
            return Date.now() + (10 * 1000)
        }
    })
    return status;
}

/**
 * Creates a new Biteup group
 */
export const createGroup = functions.https.onCall(
    async (data : groupCreationRequest, context) => {
    
    authCheck(context)
    if (isEmptyObject(data.usersToAdd) || (isOnlyWhitespace(data.name))){
        throw new functions.https.HttpsError(
            'invalid-argument', "Empty member list or invlaid group name")
    }

    let groupMasterPath = `/userGroups/`
    const groupUid = database.ref(groupMasterPath).push().key
    groupMasterPath += groupUid

    const userUid = context.auth?.uid
    const updates = {} as any
    const snippetAdditionPromises = []
    const additionPromise = async (uid : string) => {
        const snippetSnapshot = await database.ref(`userSnippets/${uid}`).once("value")
        if (!snippetSnapshot.exists()){
            throw new functions.https.HttpsError('failed-precondition', "A User you're trying to add doesn't exist");
        }
        const rank = uid === userUid ? groupRanks.ADMIN : groupRanks.STANDARD
        updates[`${groupMasterPath}/memberSnippets/${uid}`] = {...snippetSnapshot.val(), rank}
    }

    //The member count and admin count is handled by a trigger cloud function
    updates[`${groupMasterPath}/snippet`] = {
        name: data.name,
        leaseTime: Date.now(),
        lastEditId: database.ref().push().key
    }
    for (const uid of [...Object.keys(data.usersToAdd), userUid]) {
        updates[`userGroupMemberships/${uid}/${groupUid}`] = {name: data.name}
        updates[`${groupMasterPath}/memberUids/${uid}`] = uid === userUid ? groupRanks.ADMIN : groupRanks.STANDARD
        snippetAdditionPromises.push(additionPromise(<string>uid))
    }

    await Promise.all(snippetAdditionPromises)
    await database.ref().update(updates);
    return {status: returnStatuses.OK}
});

/**
 * Edits a Group by Adding/removing users or renaming a group or promoting/demoting people
 */
export const editGroup = functions.https.onCall(
    async (data : groupEditRequest, context) => {
    
    authCheck(context)

    const userRank = (await database
        .ref(`/userGroups/${data.groupUid}/memberSnippets/${context.auth?.uid}/rank`)
        .once("value")).val()

    //Checking if this user is removing someone apart from themselves from the group
    const isRemovingOther = (data.usersToRemove 
        && Object.keys(data.usersToRemove).length > 1
        && !data.usersToRemove[(<any>context.auth).uid])

    const isChangingRank = !isNullOrUndefined(data.usersToPromote) || !isNullOrUndefined(data.usersToDemote)

    if (!(await database.ref(`/userGroups/${data.groupUid}/snippet/name`).once("value")).exists()){
        throw new functions.https.HttpsError('invalid-argument', 'Group does not exitst');
    }else if (!userRank){
        throw new functions.https.HttpsError('failed-precondition', 'Not a member of this group');
    }else if (userRank !== groupRanks.ADMIN && (isRemovingOther || isChangingRank)){
        throw new functions.https.HttpsError('permission-denied', 'Required admin privilidges');
    }

    //Making sure noone is being demoted and prototed at the same time
    if (!isNullOrUndefined(data.usersToPromote) && !isNullOrUndefined(data.usersToDemote)){
        for (const key in data.usersToDemote) {
            if ((<Object>data.usersToPromote).hasOwnProperty(key)) {
                throw new functions.https.HttpsError('invalid-argument', 'Cannot promote and demote same user');     
            }
        }
    }

    if (data.usersToAdd){
        //Making sure noone is being promoted/demoted and removed at the same time
        const allRankChangeUsers = {...(data.usersToPromote || {}), ...(data.usersToDemote || {})}
        for (const uid in allRankChangeUsers) {
            if ((<Object>data.usersToAdd).hasOwnProperty(uid)) {
                throw new functions.https.HttpsError('invalid-argument', 'Cannot promote/demote and remove same user');     
            }
        }
    }


    //Attempting to claim lease before we do any changes
    const groupLeaseStatus = await claimGroupLease(data.groupUid)
    if (groupLeaseStatus !== leaseStatus.AVAILABLE){
        return {status: returnStatuses.LEASE_TAKEN}
    }
    
    let updates = {} as any
    if (data.usersToAdd) updates = {...updates, ...await addMembers(data)}
    if (data.usersToRemove) updates = {...updates, ...removeMembers(data)}
    if (data.newName) updates = {...updates, ...await updateGroupName(data)}
    if (data.usersToPromote) updates = {...updates, ...await changeRank(data, groupRanks.ADMIN)}
    if (data.usersToDemote) updates = {...updates, ...await changeRank(data, groupRanks.STANDARD)}
    updates[`/userGroups/${data.groupUid}/snippet/lastEditId`] = database.ref().push().key
    await database.ref().update(updates);
    return {status: returnStatuses.OK}
});

export const deleteGroup = functions.https.onCall(
    async (data : groupEditRequest, context) => {
    
    authCheck(context)
    const userRank = (await database
        .ref(`/userGroups/${data.groupUid}/memberSnippets/${context.auth?.uid}/rank`)
        .once("value")).val()

    if (!(await database.ref(`/userGroups/${data.groupUid}/snippet/name`).once("value")).exists()){
        throw new functions.https.HttpsError('invalid-argument', 'Group does not exitst');
    }else if (!userRank){
        throw new functions.https.HttpsError('failed-precondition', 'Not a member of this group');
    }else if (userRank !== groupRanks.ADMIN){
        throw new functions.https.HttpsError('permission-denied', 'Required admin privilidges');
    }

    //Attempting to claim lease before we do any changes
    const groupLeaseStatus = await claimGroupLease(data.groupUid)
    if (groupLeaseStatus !== leaseStatus.AVAILABLE){
        return {status: returnStatuses.LEASE_TAKEN}
    }

    const currentMembers = 
        (await database.ref(`/userGroups/${data.groupUid}/memberUids`).once("value")).val()

    const updates = removeMembers({groupUid: data.groupUid, usersToRemove: currentMembers})
    updates[`/userGroups/${data.groupUid}/snippet/lastEditId`] = database.ref().push().key
    await database.ref().update(updates); //Group snippet will be removed by updateGroupMemberAndAdminCount 
    return {status: returnStatuses.OK}
});


export const updateGroupMemberAndAdminCount = functions.database.ref('/userGroups/{groupUid}/snippet/lastEditId')
    .onWrite(async (snapshot, context) => {
    const currentEditId = await database.ref(`/userGroups/${context.params.groupUid}/snippet/lastEditId`)
        .once("value");
    //Make sure that this trigger is the trigger caused by the edit that most recently
    //Edited the group. Otherwise, don't do anything
    if (currentEditId.val() !== snapshot.after.val()) return;
    if (currentEditId.val() === null) return; //Group snippet (and hence whole group) has been deleted
    const currentMembers = await database.ref(`/userGroups/${context.params.groupUid}/memberUids`)
        .once("value")
    if (!currentMembers.exists()){ //Someone has removed all the members, so the group is to be deleted
        //Finish the deletion off by deleting the snippet
        await database.ref(`/userGroups/${context.params.groupUid}/snippet`).remove()
    }else{ //Recalculate member and admin counts
        let updates = {} as any
        let adminCount = 0
        let memberCount = 0
        const memberList = currentMembers.val()
        for (const memberUid in memberList) {
            memberCount ++;
            if (memberList[memberUid] === groupRanks.ADMIN) adminCount ++
        }
        if (adminCount === 0){ //The last admin has left, assign a new random one
            const newAdmin = randomKey(memberList)
            const params: groupEditRequest = {
                groupUid: context.params.groupUid,
                usersToPromote: {},
            }
            const usersToPromote : any = params.usersToPromote //I did it this way to avoud ts errors
            usersToPromote[newAdmin] = true
            updates = {...updates, ...await changeRank(params, groupRanks.ADMIN, false)}
            adminCount = 1
        }
        updates[`/userGroups/${context.params.groupUid}/snippet/adminCount`] = adminCount
        updates[`/userGroups/${context.params.groupUid}/snippet/memberCount`] = memberCount
        await database.ref().update(updates);
    }
});

const addMembers = async (data : groupEditRequest) => {
    const updates = {} as any
    const snippetAdditionPromises = []

    const name = data.newName || 
        (await database.ref(`/userGroups/${data.groupUid}/snippet/name`).once("value")).val()
    
    const currentMembers = 
        (await database.ref(`/userGroups/${data.groupUid}/memberUids`).once("value")).val()
    
    //Making sure we don't re-add people who are already in the group
    const newMembers = objectDifference(<object>data.usersToAdd, currentMembers)
    const snippetAdditionPromise = async (uid : string) => {
        const snippetSnapshot = await database.ref(`userSnippets/${uid}`).once("value")
        if (!snippetSnapshot.exists()){
            throw new functions.https.HttpsError('failed-precondition', "You're trying to add someone who doesn't exits");
        }
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

const removeMembers = (data : groupEditRequest) => {
    const updates = {} as any
    for (const uid in data.usersToRemove){
        updates[`/userGroups/${data.groupUid}/memberUids/${uid}`] = null
        updates[`/userGroups/${data.groupUid}/memberSnippets/${uid}`] = null
        updates[`userGroupMemberships/${uid}/${data.groupUid}`] = null
    }
    return updates
}

const changeRank = async (data: groupEditRequest, newRank: groupRanks, checkIfUsersValid : boolean = true) => {
    const updates = {} as any
    const rankChangePromises = []
    const targetUsers = (newRank === groupRanks.ADMIN) ? data.usersToPromote : data.usersToDemote

    //Making sure these users are indeed in the groups
    const rankChangePromise = async (uid : string) => {
        if (checkIfUsersValid){
            const currentRankSnapshot = await database.ref(`/userGroups/${data.groupUid}/memberUids/${uid}`).once("value")
            if (!currentRankSnapshot.exists()){
                throw new functions.https.HttpsError('failed-precondition', "You're trying to change the rank of someone who isn't a part of this group");
            }
        }
        updates[`/userGroups/${data.groupUid}/memberSnippets/${uid}/rank`] = newRank 
        updates[`/userGroups/${data.groupUid}/memberUids/${uid}`] = newRank 
    }
    for (const uid in targetUsers) {
        rankChangePromises.push(rankChangePromise(uid))
    }
    await Promise.all(rankChangePromises)
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

export interface GroupsPaths {
    groupMembershipSection : string,
    snippetsInGroups: Array<string>,
    uidsInGroups: Array<string>
}

export const getAllGroupPaths = async (userUid : string) : Promise<GroupsPaths> => {
    const paths : GroupsPaths =  {
        groupMembershipSection : "",
        snippetsInGroups: [],
        uidsInGroups: []
    }
    paths.groupMembershipSection = `userGroupMemberships/${userUid}`
    const allGroups = (await database.ref(`userGroupMemberships/${userUid}`).once("value")).val()
    for (const groupUid in allGroups) {
        paths.uidsInGroups.push(`/userGroups/${groupUid}/memberUids/${userUid}`)
        paths.snippetsInGroups.push(`/userGroups/${groupUid}/memberSnippets/${userUid}`)
    }
    return paths
}