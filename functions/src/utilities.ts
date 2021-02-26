// Callable HTTPS Cloud Functions can terminate in 4 different ways:
// 1) They can terminate successully, returning a success report to the client.
// 2) They can have a non native error (probably due to invalid parameters or invalid database states).
// In this case, the function will return an error report (instead of throwing something, since that
// will cause the functions server instance to be deallocated and cause more cold starts).
// 3) It can have a non-native error that has been determied to be fatal by the developer. In this case,
// the function will throw a fatal error report to the client.
// 4) The function can throw a native error (an actual Error() object coming from something unexpected).
// In this case, the function will just log the error and throw it back to the client.

import { HttpsError} from "firebase-functions/lib/providers/https";

export enum ExecutionStatus {
    OK = "successful",
    INVALID = "invalid state",
    LEASE_TAKEN = "lease taken"
}

interface ExecutionReport {
    status: ExecutionStatus,
    message?: any,
    fatal?: boolean
}

type ErroneousStatus = Exclude<ExecutionStatus, ExecutionStatus.OK>;

function createReport(status : ExecutionStatus, message? : any, fatalError?: boolean ) : ExecutionReport {
    const response: ExecutionReport  = {status};
    if (message) response.message = message
    if (fatalError) response.fatal = true
    return response;
}

/**
 * Generates a report that will be sent to the user if the function executed successfully
 * @param message Additional info that will be given to the user
 */
// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export function successReport (message? : any) : ExecutionReport {
    return createReport(ExecutionStatus.OK, message)
}

/**
 * Generates a report that will be sent to the user if there is a non-native error (like a data inconsistency)
 * @param status The error status
 * @param message Additional info that will be given to the user
 * @param fatal Is this error fatal (ie should the server instance deallocate?)
 */
export function errorReport (
    message = "Something wrong happened; please try again!", 
    status : ErroneousStatus = ExecutionStatus.INVALID,
    fatal?: boolean) : ExecutionReport {
    return createReport(status, message, fatal)
}

/**
 * Takes an Error or erroneous ExecutionReport and determines if the error is fatal or native.
 * If it is, it's thrown. If it's not, it's merely returned. This is intended to be called in a catch block
 * @param err The object
 */


import {error} from "firebase-functions/lib/logger";
// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export function handleError(err : any) : any {
    //Keep in mind that throwing errors also deallocates the server instance
    if (err.name){ //It's an Error() object
        error(err)
        const HttpsFunctionsErrorCodes = [
            'ok', 'cancelled', 'unknown', 'invalid-argument', 
            'deadline-exceeded', 'not-found', 'already-exists', 'permission-denied', 
            'resource-exhausted', 'failed-precondition', 'aborted', 'out-of-range', 'unimplemented', 
            'internal', 'unavailable', 'data-loss', 'unauthenticated'];
        if (HttpsFunctionsErrorCodes.includes(err.code || "")){ //It's an https error
            throw err; 
        }else{ //It's another type of error
            throw new HttpsError('unknown', "Something wrong happened! Please try again")
        }
    }else if (err.fatal){ //It's a fatal execution report
        const constructedError = new Error(err.message); //Assumes err is an errorReport made via errorReport() so message : string
        throw constructedError;
    }else{ //It's a non-fatal execution report
        return err
    }
}

/**
 * The different states that a database lease can have.
 */
export enum leaseStatus {
    AVAILABLE = "available",
    TAKEN = "taken",
    NONEXISTENT = 'non-existent'
}

/**
 * Determines if a value is null or undefined
 */
export function isNullOrUndefined(value : unknown) : boolean {
    return (typeof value === "undefined") || value === null
}

/**
 * Determines if the entered object is empty
 */
export function isEmptyObject (obj : Record<string, unknown>) : boolean{
    for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            return false;
        }
    }
    return true;
}

/**
 * Determines is a string is only whitespace
 * @param {string} str The stirng
 */
export const isOnlyWhitespace = (str: string) : boolean => {
    return str.replace(/\s/g, '').length === 0
}
  

/**
 * Truncates a string that surpasses a cetain max length and adds ellipses
 */
export function truncate(inputString : string, maxLength : number) : string {
    if (inputString.length > maxLength)
       return inputString.substring(0,maxLength) + '...';
    else
       return inputString;
}

/**
 * Returns an set of keys that are in A but not in B
 * @param objA Object A
 * @param objB Object B
 */
export function objectDifference(objA : Record<string, unknown>, objB : Record<string, unknown>) : Set<any> {
    const setA = new Set(Object.keys(objA))
    const setB = new Set(Object.keys(objB))
    return new Set([...setA].filter(x => !setB.has(x)))
}

/**
 * Get s a random key from an object
 */
export function randomKey (obj: Record<string, unknown>) : string{
    const keys = Object.keys(obj);
    return keys[ keys.length * Math.random() << 0 ];
}