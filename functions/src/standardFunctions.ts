export function isNullOrUndefined(value : any) : Boolean {
    return (typeof value === "undefined") || value === null
}

export function isEmptyObject (obj : {[key: string]: any}){
    for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
            return false;
        }
    }
    return true;
}

export function truncate(inputString : string, maxLength : number) {
    if (inputString.length > maxLength)
       return inputString.substring(0,maxLength) + '...';
    else
       return inputString;
 };