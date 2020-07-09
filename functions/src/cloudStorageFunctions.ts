import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';
import { DeleteFileResponse } from '@google-cloud/storage';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path');

// Creating our cloud client
const bucket = admin.storage().bucket()

/**
 * This function deletes a user's older profile pic after a new one is uploaded
 * It is only listeneing for pictures created by the image resizer
 */
export const deleteOlderProfilePic = functions.storage.object().onFinalize(async (object) => {
    const picFolder = path.basename(path.dirname(object.name))
    if (picFolder !== "scaled") return;
    const allProfilepics = await bucket.getFiles({directory: path.dirname(object.name)})
    const deletionPromises: Array<Promise<DeleteFileResponse>> = []
    allProfilepics[0].forEach((file)  => {
        if (file.name !== object.name) 
            deletionPromises.push(bucket.file(file.name).delete())
    });
    await Promise.all(deletionPromises)
});

export interface CloudStoragePaths {
    profilePictureDirectory : string,
}
export const getCloudStoragePaths = async (userUid : string) : Promise<CloudStoragePaths> => {
    const paths : CloudStoragePaths = {profilePictureDirectory : `profilePictures/${userUid}`}
    return paths
}