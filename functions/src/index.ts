import * as admin from 'firebase-admin';
// This import added because of 
// https://github.com/firebase/firebase-functions/issues/596
// tslint:disable-next-line:no-import-side-effect
import 'firebase-functions';
import { ingestEnvVariables } from './utils/env/envVariableIngestor';

const firebaseConfig = JSON.parse(<string>process.env.FIREBASE_CONFIG);
admin.initializeApp({
    ...firebaseConfig,
    credential: admin.credential.applicationDefault() //For FCM
});

//Its important that this is used before we import (or export from) any other classes
//since some modules will initialize values based off the ingested env variables
ingestEnvVariables()

export * from './accountManagementFunctions';
export * from './devFunctions/dbMgmtFunctions/notificationManagement';
export * from './devFunctions/testFunctions/emailAndDomains';
export * from './devFunctions/testFunctions/notificationTests';
export * from './emailLists';
export * from './emailVerification';
export * from './fcmFunctions/fcmBasicEvents';
export * from './fcmFunctions/fcmCore';
export * from './fcmFunctions/fcmReminders';
export * from './flares/common';
export * from './flares/privateFlares';
export * from './flares/publicFlares';
export * from './flares/publicFlareUserMetadata';
export * from './friendMaskFunctions';
export * from './friendRecommendations';
export * from './friendRequestFunctions';
export * from './profilePictureFunctions';
export * from './statsFunctions/onNewUser';
export * from './userGroupFunctions';
export * from './userInviting';
