import * as admin from 'firebase-admin';

// This import added because of 
// https://github.com/firebase/firebase-functions/issues/596
// tslint:disable-next-line:no-import-side-effect
import 'firebase-functions';

const firebaseConfig = JSON.parse(<string>process.env.FIREBASE_CONFIG);
admin.initializeApp({
    ...firebaseConfig,
    credential: admin.credential.applicationDefault() //For FCM
});

export * from './testFunctions/notificationTests'
export * from './fcmFunctions'
export * from './friendRequestFunctions'
export * from './activeBroadcastFunctions'
export * from './cloudStorageFunctions'
export * from './friendMaskFunctions'
export * from './userGroupFunctions'
export * from './accountManagementFunctions'