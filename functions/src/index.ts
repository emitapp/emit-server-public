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

export * from './accountManagementFunctions';
export * from './profilePictureFunctions';
export * from './devFunctions/dbMgmtFunctions/notificationManagement';
export * from './devFunctions/testFunctions/notificationTests';
export * from './fcmFunctions/fcmBasicEvents';
export * from './fcmFunctions/fcmReminders';
export * from './friendMaskFunctions';
export * from './friendRecommendations';
export * from './friendRequestFunctions';
export * from './flares/privateFlares';
export * from './flares/publicFlares';
export * from './statsFunctions/onNewUser';
export * from './flares/common';
export * from './userGroupFunctions';
export * from './userInviting';
export * from './fcmFunctions/fcmCore';
export * from './emailLists'


