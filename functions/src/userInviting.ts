import * as functions from 'firebase-functions';
import {handleError, successReport, errorReport, chunkArray} from './utils/utilities';
import admin = require('firebase-admin');
import { parsePhoneNumberFromString } from 'libphonenumber-js'


const database = admin.database()
const firestore = admin.firestore();
const userMetadata = firestore.collection("userMetadata")

interface contactInfo{
    emails:string[],
    phoneNumbers:string[]
}


/**
 * Gets the uids of users based on an email list.
 * //TODO: I suspect this may become a point of abuse, so maybe later on this should be made more secure
 */
export const getUsersFromContacts = functions.https.onCall(
    async (data : contactInfo, context) => {
    try{

        if (!context.auth) {
            throw errorReport("Authentication Needed")
        } 

        const snippets : Record<string, any> = {}
        const promises : Promise<void>[] = []


        const snippetGetPromise = async (uid: string) => {
            if (!snippets[uid]){
                const snapshot = await database.ref(`userSnippets/${uid}`).once('value'); 
                snippets[uid] = {...snapshot.val(), uid: snapshot.key}
            }
        }

        const snippetRetrievalPromiseEmial = async (email : string) => {
            try{
                const user = await admin.auth().getUserByEmail(email) 
                await snippetGetPromise(user.uid)
            }catch(err){
                //If there was an error simply becuase the user didn't exist, ignore
                if (err?.code == "auth/user-not-found") return;
                if (err?.code == "auth/invalid-email") return;
                //Otherwise this is a legitimate error and it should bubble up
                throw err
            }  
        }

        const snippetRetrievalPromisePhone = async (phoneList : string[]) => {
            const internationals = await userMetadata.where('phoneNumberInfo.phoneNumberInternational', 'in', phoneList).get()
            const locals = await userMetadata.where('phoneNumberInfo.phoneNumberLocal', 'in', phoneList).get()
            let promises : any[] = []
            internationals.forEach(doc => promises.push(doc.id))
            locals.forEach(doc => promises.push(doc.id))
            promises = promises.map(uid => snippetGetPromise(uid));
            await Promise.all(promises)     
        }

        if (data.emails){
            data.emails.forEach(e => promises.push(snippetRetrievalPromiseEmial(e)))
        }

        if (data.phoneNumbers){
            //First formatting the phone numbers...
            data.phoneNumbers = data.phoneNumbers.map(n => {
                const p = parsePhoneNumberFromString(n, "US")
                if (!p) return "" //Invalid number, will be filtered out later...
                if (n.includes("+")) return p.formatInternational()
                return p.formatNational()
            })

            data.phoneNumbers = data.phoneNumbers.filter(num => num != "")

            //Chunks shouldn't be larger than 10 since firestore "in" operator only works up to 10
            const chunkedPhoneNumbers : string[][] = chunkArray(data.phoneNumbers, 10)
            chunkedPhoneNumbers.forEach(numberList => promises.push(snippetRetrievalPromisePhone(numberList)))
        }

        await Promise.all(promises)
        return successReport(snippets)
    }catch(err){
        return handleError(err)
    }
});