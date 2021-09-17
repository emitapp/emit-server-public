import * as functions from 'firebase-functions';
import {
    errorReport, handleError, successReport
} from '../../utils/utilities';
import admin = require('firebase-admin');



const database = admin.database()

/**
 * Turns a public group private or vise versa
 */
export const dev_changeGroupVisibility = functions.https.onCall(
    async (groupUid: string, _) => {
        try {
            const updates = {} as any
            const groupSnippet = (await database.ref(`/userGroups/${groupUid}/snippet`).once("value"))

            if (!groupSnippet.exists()) throw errorReport('Group does not exitst');

            updates[`/userGroups/${groupUid}/snippet/isPublic`] = groupSnippet.val().isPublic ? false : true
            await database.ref().update(updates)
            return successReport("Is public now? " + !groupSnippet.val().isPublic)
        } catch (err) {
            return handleError(err)
        }
    });