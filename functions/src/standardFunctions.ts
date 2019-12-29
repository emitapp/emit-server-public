export function isNullOrUndefined(value : any) : Boolean {
    return (typeof value === "undefined") || value === null
}