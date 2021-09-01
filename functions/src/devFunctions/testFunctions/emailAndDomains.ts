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
    
    if (builtInEnvVariables.runningInEmulator){
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
