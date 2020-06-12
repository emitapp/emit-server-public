import {HttpsError} from 'firebase-functions/lib/providers/https'

export function notSignedInError(): HttpsError {
    return new HttpsError(
        'unauthenticated', 
        'You have to be signed in to do this!');
} 

export enum returnStatuses {
    OK = "successful",
    NOTO = "non existent receiver",
    INVALID = "other invalid state",
    LEASE_TAKEN = "lease is currently taken"
}

export enum leaseStatus {
    AVAILABLE = "available",
    TAKEN = "taken",
    NONEXISTENT = 'non-existent'
}