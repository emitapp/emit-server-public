export interface fromToStruct {
    from: string,
    to: string
}

export interface friendRequestCancelStruct extends fromToStruct {
    fromInbox: boolean
}