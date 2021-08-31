import * as functions from 'firebase-functions';
import { extraUserInfoEmailOnly } from '../emailVerification';
import { hashOrgoNameForFirestore } from '../utils/strings';
import admin = require('firebase-admin');

const firestore = admin.firestore()
const collectionName = "publicFlareUserMetadataPrivate"

export interface publicFlareUserMetadataPrivateInterface {
    domain?: string //Managed by triggers
    hashedDomain?: string, //Managed by triggers
    geoHash?: string, //user uploaded
    geolocation?: { //user uploaded
        latitude: number, 
        longitude: number
    }
}

export const syncPrivatePublicFlareMetaOnDomainCreate = functions.firestore.document(`publicExtraUserInfo/{userUid}`)
    .onCreate((snap, context) => {
        const data = snap.data() as extraUserInfoEmailOnly;
        if (!data.lastVerifiedEmailDomain) return null;

        const valueToSet: publicFlareUserMetadataPrivateInterface = {
            domain: data.lastVerifiedEmailDomain,
            hashedDomain: hashOrgoNameForFirestore(data.lastVerifiedEmailDomain)
        }

        return firestore
            .collection(collectionName)
            .doc(context.params.userUid)
            .set(valueToSet, { merge: true })
    });


export const syncPrivatePublicFlareMetaOnDomainUpdate = functions.firestore.document(`publicExtraUserInfo/{userUid}`)
    .onUpdate(async (snap, context) => {
        const data = snap.after.data() as extraUserInfoEmailOnly;

        if (!data?.lastVerifiedEmailDomain) {
            const doc = await firestore
                .collection(collectionName)
                .doc(context.params.userUid)
                .get()

            if (doc.exists) {
                await doc.ref.update({
                    domain: admin.firestore.FieldValue.delete(),
                    hashedDomain: admin.firestore.FieldValue.delete()
                })
            }
            return;
        }

        const valueToSet: publicFlareUserMetadataPrivateInterface = {
            domain: data.lastVerifiedEmailDomain,
            hashedDomain: hashOrgoNameForFirestore(data.lastVerifiedEmailDomain)
        }

        await firestore
            .collection(collectionName)
            .doc(context.params.userUid)
            .set(valueToSet, { merge: true })
    });


export interface PublicFlareUserMetadataPrivatePath {
    metadatapath: string,
}

export const getPrivatePublicFlareMetadataPath = (userUid: string): PublicFlareUserMetadataPrivatePath => {
    return {
        metadatapath: `${collectionName}/${userUid}`
    }
}




