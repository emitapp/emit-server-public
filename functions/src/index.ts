import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

admin.initializeApp({
    ...functions.config().firebase,
    storageBucket: "the-og-lunchme.appspot.com"
});

export * from './friendRequestFunctions'
export * from './activeBroadcastFunctions'
export * from './cloudStorageFunctions'
