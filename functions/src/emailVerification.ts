/* eslint-disable @typescript-eslint/ban-ts-comment */
import * as functions from 'firebase-functions';
import { UserRecord } from 'firebase-functions/lib/providers/auth';
import { URL, URLSearchParams } from 'url';
import { UserSnippet } from './accountManagementFunctions';
import { sendEmailFromCustomDomain } from './utils/emails';
import { envVariables } from './utils/env/envVariables';
import { getDomainFromEmail, hashOrgoNameForFirestore } from './utils/strings';
import { errorReport, ExecutionStatus, handleError, successReport } from './utils/utilities';
import admin = require('firebase-admin');

const firestore = admin.firestore()
const database = admin.database()


const emailVerificationEmailHost = envVariables.emailVerification.email_host
const emailVerificationEmailAddress = envVariables.emailVerification.email_address;
const emailVerificationEmailPassword = envVariables.emailVerification.email_password;
const emailVerificationEmailUseTLS = envVariables.emailVerification.use_tls;
const emailVerificationEmailPort = envVariables.emailVerification.email_port;
const emailVerificationEmailFollowURL = envVariables.emailVerification.follow_url;
const isProd = envVariables.emailVerification.is_prod
const handlerUrl = envVariables.emailVerification.handler_url;

interface userVerificationInfo {
    verificationLinkParams: string,
    emailAssociatedWithLink: string,
    timestamp: number
}

export interface extraUserInfoEmailOnly {
    lastVerifiedEmailDomain: string,
    hashedDomain: string,
}

const verificationCollection = firestore.collection('userEmailVerifications')
export const extraUserInfoCollection = firestore.collection('publicExtraUserInfo')


export const sendVerificationEmail = functions.https.onCall(async (_, context) => {
    try {

        //Added due to Emit end-of-life
        throw errorReport("This operation isn't supported anymore!", ExecutionStatus.NOT_SUPPORTED)

        if (!context.auth) throw errorReport("Authentication Required")
        // @ts-ignore: Object is possibly 'undefined'
        const userRecord = await admin.auth().getUser(context.auth.uid);
        await _sendVerificationEmail(userRecord);
        return successReport("Verification Email Sent!")
    } catch (err) {
        return handleError(err)
    }
})

const _sendVerificationEmail = async (user: UserRecord) => {
    if (!isProd) throw errorReport("This is a dev server; use the shell commands to verify instead")
    //Basic checks
    if (!user.email) return
    if (!getDomainFromEmail(user.email)) throw errorReport("We can't get an email associated with your account!")
    const snippetSnapshot = await database.ref(`userSnippets/${user.uid}`).once('value');
    if (!snippetSnapshot.exists()) throw errorReport("This user hasn't finished setting up their profile.")
    const snippet: UserSnippet = snippetSnapshot.val();

    //Making the link
    const actionCodeSettings = {
        url: emailVerificationEmailFollowURL,
        handleCodeInApp: false //ensure that the link will open into browser
    };
    const link = await admin.auth().generateEmailVerificationLink(user.email, actionCodeSettings);
    const linkParams = new URL(link).searchParams;
    const newURLFull = new URL(handlerUrl)
    for (const [key, val] of linkParams.entries()) {
        newURLFull.searchParams.set(key, val)
    }


    const valueToSet: userVerificationInfo = {
        verificationLinkParams: codifyLinkSearchParams(linkParams),
        emailAssociatedWithLink: user.email,
        timestamp: Date.now()
    }
    await verificationCollection.doc(user.uid).set(valueToSet, { merge: true });

    //Sending the email
    const subject = "Let's get your email verified!"
    let mailMessage = `<p><strong>Heya ${snippet.displayName}!&nbsp;👋👋🏾</strong></p>\n`
    mailMessage += '<p>Looks like you\'re trying to verify your Emit email address!</p>\n'
    mailMessage += "<p>Simply click this link below and you should be good to go!</p>\n\n"
    mailMessage += `<a href="${newURLFull}">${newURLFull}</a>`
    mailMessage += '<p>\n\nCiao!</p>\n\n'
    mailMessage += "<p>P.S: Don't reply to this email address - it's never checked.</p>"

    await sendEmailFromCustomDomain(
        emailVerificationEmailHost,
        emailVerificationEmailPort,
        emailVerificationEmailUseTLS,
        emailVerificationEmailAddress,
        emailVerificationEmailPassword,
        user.email,
        subject,
        mailMessage
    )
}

export const verifyEmail = functions.https.onRequest(async (req, res) => {
    //Since the website that calls this is a React project...
    res.set('Access-Control-Allow-Origin', "*"); //TODO: Should probably make this more secure later
    try {
        //Generating the id that would correspond to the doc in firestore
        const { mode, oobCode, apiKey } = req.query;
        const params = new URLSearchParams();
        params.append("mode", encodeURIComponent(mode?.toString() || ""))
        params.append("oobCode", encodeURIComponent(oobCode?.toString() || ""))
        params.append("apiKey", encodeURIComponent(apiKey?.toString() || ""))

        //Querying for doc
        const queryRef = await verificationCollection
            .where("verificationLinkParams", "==", codifyLinkSearchParams(params))
            .get();
        const verificationDoc = queryRef.docs[0] //Assumes only one doc will be in the query
        if (!verificationDoc) {
            res.status(400).send("We couldn't find this request! Either you are already verified, or this request is invalid.");
            return
        }
        const docData = verificationDoc.data() as userVerificationInfo

        //Update backend and return
        const domain = getDomainFromEmail(docData.emailAssociatedWithLink)
        if (!domain) {
            res.status(400).send("Could not get domain from email.");
            return
        }
        admin.auth().updateUser(verificationDoc.id, { emailVerified: true })
        const valueToSet: extraUserInfoEmailOnly = {
            lastVerifiedEmailDomain: domain,
            hashedDomain: hashOrgoNameForFirestore(domain)
        }
        await extraUserInfoCollection.doc(verificationDoc.id).set(valueToSet, { merge: true });
        await verificationDoc.ref.delete()
        res.status(200).send("Email verified! Restart the app and it'll be applied :)")
    } catch (err) {
        res.status(500).send();
    }
});

const codifyLinkSearchParams = (params: URLSearchParams) => {
    //Verification links have more than this, but these are the ones that are the most important
    //https://firebase.google.com/docs/auth/custom-email-handler#web-v8_1
    const mode = params.get("mode") || "xxx"
    const oobCode = params.get("oobCode") || "xxx"
    const apiKey = params.get("apiKey") || "xxx"
    return mode + oobCode + apiKey
}

//For now tis will be here, but it should eventually be moved to a place that manages
//"extrauserinfo" in general
export interface ExtraUserInfoPaths {
    extraInfoPath: string,
}

export const getExtraUserInfoPaths = (userUid: string): ExtraUserInfoPaths => {
    return {
        extraInfoPath: `publicExtraUserInfo/${userUid}`
    }
}
export interface EmailVerificationPaths {
    emailVerificationPath: string,
}

export const getEmailVerificationPaths = (userUid: string): EmailVerificationPaths => {
    return {
        emailVerificationPath: `userEmailVerifications/${userUid}`
    }
}