/**
 * Determines if a value is null or undefined
 */
export function isNullOrUndefined(value : any) : Boolean {
    return (typeof value === "undefined") || value === null
}

/**
 * Determines if the entered object is empty
 */
export function isEmptyObject (obj : {[key: string]: any}){
    for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
            return false;
        }
    }
    return true;
}

/**
 * Determines is a string is only whitespace
 * @param {string} str The stirng
 */
export const isOnlyWhitespace = (str: string) => {
    return str.replace(/\s/g, '').length === 0
}
  

/**
 * Truncates a string that surpasses a cetain max length and adds ellipses
 */
export function truncate(inputString : string, maxLength : number) {
    if (inputString.length > maxLength)
       return inputString.substring(0,maxLength) + '...';
    else
       return inputString;
};

/**
 * Returns an set of keys that are in A but not in B
 * @param objA Object A
 * @param objB Object B
 */
export function objectDifference(objA : object, objB : object) : Set<any> {
    const setA = new Set(Object.keys(objA))
    const setB = new Set(Object.keys(objB))
    return new Set([...setA].filter(x => !setB.has(x)))
}