import {HttpsError} from 'firebase-functions/lib/providers/https'

export function notSignedInError(): HttpsError {
    return new HttpsError(
        'unauthenticated', 
        'You have to be signed in to do this!');
} 

export const returnStatuses = {
    OK: "successful",
    NOTO: "non existent receiver"
}