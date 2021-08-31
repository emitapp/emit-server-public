import {v5 as uuidv5} from "uuid"

export const hashOrgoNameForFirestore = (name: string): string => {
    const normalizedName = name.trim().normalize("NFKC")
    const NAMESPACE = "ec2be00f-c168-402c-91ce-a2a48086b11e" //arbitrary, https://www.uuidgenerator.net/
    const hash = uuidv5(normalizedName, NAMESPACE);
    return hash
}

export const getDomainFromEmail = (email: string) : string | undefined=> {
    return email.split("@").pop()
}