import * as functions from 'firebase-functions';
import admin = require('firebase-admin');
import { geohashQueryBounds, distanceBetween } from 'geofire-common';

const database = admin.database()

interface Coordinates{
  latitude: number
  longitude: number
}

export const removeUserLocationHashesOnPreferenceChange = functions.database.ref('/userLocationUploadPreference/{userUid}')
  .onWrite(async (snapshot, context) => {
    const newValue = snapshot.after.val()
    if (!newValue){ 
      await database.ref(`userLocationGeoHashes/${context.params.userUid}`).remove()
    }
});

export const PUBLIC_FLARE_RADIUS_IN_M = 9656 //6 miles


export const getUsersNearLocation = async (center: Coordinates, radiusInM: number) : Promise<string[]> => {
  const uidSet : Set<string> = new Set()
  const promises : Promise<void>[] = []
  const queryCenter = [center.latitude, center.longitude];
  const bounds = geohashQueryBounds(queryCenter, radiusInM);

  const retrievalPromise = async (b : string[]) => {
    const ref = database.ref("userLocationGeoHashes").orderByChild("geoHash").startAt(b[0]).endAt(b[1]).limitToFirst(300)
    const snapValue = await ref.once("value")
    snapValue.forEach(data => {
      if (isFalsePositive(data.val().geolocation, center, radiusInM)) return
      if (data.key) uidSet.add(data.key)
    })
  }

  for (const b of bounds) promises.push(retrievalPromise(b))
  await Promise.all(promises)
  return Array.from(uidSet)
}

export const isFalsePositive = (coordsA: Coordinates, coordsB: Coordinates, radiusInM: number) : boolean => {
  const distanceInKm = distanceBetween(
    [coordsA.latitude, coordsA.longitude],
    [coordsB.latitude, coordsB.longitude]);
  const distanceInM = distanceInKm * 1000;
  return (distanceInM > radiusInM)
}


export interface LocationDataPaths {
  locationGatheringPreferencePath: string,
  locationDataPath: string,
}

export const getLocationDataPaths = async (userUid: string): Promise<LocationDataPaths> => {
  const paths: LocationDataPaths = { 
    locationGatheringPreferencePath: `userLocationUploadPreference/${userUid}`,
    locationDataPath: `userLocationGeoHashes/${userUid}` }
  return paths
}
