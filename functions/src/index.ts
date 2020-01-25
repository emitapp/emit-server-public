import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

admin.initializeApp({
    ...functions.config().firebase,
    storageBucket: "the-og-lunchme.appspot.com",
    credential: admin.credential.applicationDefault() //For FCM
});

export * from './testFunctions/notificationTests'
export * from './fcmFunctions'
export * from './friendRequestFunctions'
export * from './activeBroadcastFunctions'
export * from './cloudStorageFunctions'
