import * as functions from 'firebase-functions';
import {handleError, successReport, errorReport} from './utilities';
import admin = require('firebase-admin');

const database = admin.database()


/**
 * Gets the uids of users based on an email list.
 * //TODO: I suspect this may become a point of abuse, so maybe later on this should be made more secure
 */
export const getUsersFromContacts = functions.https.onCall(
    async (emailList : string[], context) => {
    try{

        if (!context.auth) {
            throw errorReport("Authentication Needed")
        } 

        const snippets : any[] = []
        const promises : Promise<void>[] = []

        const uidRetrievalPromise = async (email : string) => {
            try{
                const user = await admin.auth().getUserByEmail(email) 
                const snapshot = await database.ref(`userSnippets/${user.uid}`).once('value'); 
                snippets.push({...snapshot.val(), uid: snapshot.key})
            }catch(err){
                //If there was an error simply becuase the user didn't exist, ignore
                if (err?.code == "auth/user-not-found") return;
                //Otherwise this is a legitimate error and it should bubble up
                throw err
            }  
        }

        emailList.forEach(e => promises.push(uidRetrievalPromise(e)))

        await Promise.all(promises)
        return successReport(snippets)
    }catch(err){
        return handleError(err)
    }
});
