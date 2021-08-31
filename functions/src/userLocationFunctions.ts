import * as functions from 'firebase-functions';
import admin = require('firebase-admin');
import { geohashQueryBounds, distanceBetween } from 'geofire-common';
import { DEFAULT_DOMAIN_HASH } from './flares/publicFlares';
import { publicFlareUserMetadataPrivateInterface } from './flares/publicFlareUserMetadata';

const firestore = admin.firestore()
interface Coordinates {
  latitude: number
  longitude: number
}

export const removeUserLocationHashesOnPreferenceChange = functions.database.ref('/userLocationUploadPreference/{userUid}')
  .onWrite(async (snapshot, context) => {
    const newValue = snapshot.after.val()
    if (!newValue) {
      const doc = await firestore.doc(`publicFlareUserMetadataPrivate/${context.params.userUid}`).get()
      if (doc.exists) {
        await doc.ref.update({
          geoHash: admin.firestore.FieldValue.delete(),
          geolocation: admin.firestore.FieldValue.delete()
        })
      }
    }
});


export const PUBLIC_FLARE_RADIUS_IN_M = 9656 //6 miles


//TODO: make this realtimedb again (?)
export const getUsersNearLocation = async (center: Coordinates, radiusInM: number, domainHash: string)
  : Promise<string[]> => {

  const uidSet: Set<string> = new Set()
  const promises: Promise<void>[] = []
  const queryCenter = [center.latitude, center.longitude];
  const bounds = geohashQueryBounds(queryCenter, radiusInM);

  const retrievalPromise = async (b: string[]) => {
    const baseRef = firestore.collection("publicFlareUserMetadataPrivate")
    let queryRef = null
    if (domainHash && domainHash != DEFAULT_DOMAIN_HASH) queryRef = baseRef.where("hashedDomain", "==", domainHash)
    queryRef = (queryRef ? queryRef : baseRef).orderBy("geoHash").startAt(b[0]).endAt(b[1]).limit(300)
    const snapValue = await queryRef.get()

    snapValue.forEach(doc => {
      const data = doc.data() as publicFlareUserMetadataPrivateInterface
      if (!data.geolocation) return
      if (isFalsePositive(data.geolocation, center, radiusInM)) return
      uidSet.add(doc.id)
    })
  }

  for (const b of bounds) promises.push(retrievalPromise(b))
  await Promise.all(promises)
  return Array.from(uidSet)
}

export const isFalsePositive = (coordsA: Coordinates, coordsB: Coordinates, radiusInM: number): boolean => {
  const distanceInKm = distanceBetween(
    [coordsA.latitude, coordsA.longitude],
    [coordsB.latitude, coordsB.longitude]);
  const distanceInM = distanceInKm * 1000;
  return (distanceInM > radiusInM)
}


export interface LocationDataPaths {
  locationGatheringPreferencePath: string,
}

export const getLocationDataPaths = async (userUid: string): Promise<LocationDataPaths> => {
  const paths: LocationDataPaths = {
    locationGatheringPreferencePath: `userLocationUploadPreference/${userUid}`,
  }
  return paths
}
