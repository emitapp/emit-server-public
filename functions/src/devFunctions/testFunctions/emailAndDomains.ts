import admin = require('firebase-admin');
import * as functions from 'firebase-functions';
import { extraUserInfoCollection, extraUserInfoEmailOnly } from '../../emailVerification';
import { builtInEnvVariables } from '../../utils/env/envVariables';
import { getDomainFromEmail } from '../../utils/strings';
import { errorReport, handleError, successReport } from '../../utils/utilities';
import { hashOrgoNameForFirestore } from '../../utils/strings';

const logger = functions.logger

interface EmailAssociationRequest {
    email: string,
    username: string,
}

const checkIfEnabled = () => {

    if (builtInEnvVariables.runningInEmulator) {
        logger.info("__TEST__ function has been called!")
        return;
    }
    logger.error("Someone attempted to access a test function even though testing is currently disabled.")
    throw errorReport('This function is only available for testing - it is disabled in production.');
}


export const test_associateUserWithDomain = functions.https.onCall(
    async (params: EmailAssociationRequest, _) => {
        try {
            checkIfEnabled();
            const domain = getDomainFromEmail(params.email ?? "")
            if (!domain) throw errorReport("Could not get domain from email.");

            if (!params.username) throw errorReport("Need username.");
            const uidFromUsername = (await admin.database().ref(`/usernames/${params.username}`).once("value")).val()
            if (!uidFromUsername) throw errorReport("Could not get id.");

            admin.auth().updateUser(uidFromUsername, { emailVerified: true })
            const valueToSet: extraUserInfoEmailOnly = {
                lastVerifiedEmailDomain: domain,
                hashedDomain: hashOrgoNameForFirestore(domain)
            }
            await extraUserInfoCollection.doc(uidFromUsername).set(valueToSet, { merge: true });
            return successReport()
        } catch (err) {
            return handleError(err)
        }
    });



export const test_unverifyUserEmail = functions.https.onCall(
    async (username: string, _) => {
        try {
            if (!username) throw errorReport("Need username.");
            const uidFromUsername = (await admin.database().ref(`/usernames/${username}`).once("value")).val()
            if (!uidFromUsername) throw errorReport("Could not get id.");

            admin.auth().updateUser(uidFromUsername, { emailVerified: false })
            return successReport()
        } catch (err) {
            return handleError(err)
        }
    });

export const test_unverifyUserEmailViaEmail = functions.https.onCall(
    async (email: string, _) => {
        try {
            if (!email) throw errorReport("Need email.");
            const user = await admin.auth().getUserByEmail(email)
            if (!user) throw errorReport("Could not get id.");

            admin.auth().updateUser(user.uid, { emailVerified: false })
            return successReport()
        } catch (err) {
            return handleError(err)
        }
    });


//Max mage size: 1k users
//Once emit gets more users this will no longer be reliable without pagination
export const test_checkIfEveryVerifiedUserHasDoc = functions.https.onCall(
    async (__, _) => {
        try {
            const users = (await admin.auth().listUsers()).users.filter(u => u.emailVerified)
            const notActualVerified = []
            for (const user of users) {
                if (!(await extraUserInfoCollection.doc(user.uid).get()).exists) notActualVerified.push(user.email)
            }
            console.log(notActualVerified)
            return successReport()
        } catch (err) {
            return handleError(err)
        }
    });
