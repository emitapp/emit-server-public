import { builtInEnvVariables, envVariables } from "./envVariables";
import { config } from "firebase-functions";

/**
 * Parses and processes the env variables passed into the function to be accessible via
 * functions/src/utils/env/envVariables.ts exports
 */
export const ingestEnvVariables = () : void => {
    //Ingesting the dev-provided env variables
    const rawEnv = config().env
    for (const [topLevelKey, topLevelEntry] of Object.entries(envVariables)){
        for (const [lowLevelKey, lowLevelEntry] of Object.entries(topLevelEntry as Record<string, any>)){

            const envValue : string | undefined = rawEnv[topLevelKey][lowLevelKey]
            const type = typeof lowLevelEntry;

            if (typeof envValue == "undefined"){
                throw new Error(`env.${topLevelKey}.${lowLevelKey} is undefined`)
            }

            if (typeof envValue != "string"){
                throw new Error(`env should only have a depth of 2`)
            }

            let numberCast : number | null = null
            switch (type){
                case "number":
                    if (envValue.includes(".")) numberCast = parseFloat(envValue)
                    else numberCast = parseInt(envValue)
                    if (isNaN(numberCast)) throw new Error(`cast env.${topLevelKey}.${lowLevelKey} is NaN`)
                    topLevelEntry[lowLevelKey] = numberCast
                    break
                case "string":
                    topLevelEntry[lowLevelKey] = envValue
                    break;
                case "boolean":
                    topLevelEntry[lowLevelKey] = ['yes', 'true'].indexOf(envValue) != -1
                    break;
                default: 
                    throw new Error ("Bad env variable type!")
            }
        }
    }

    //Ingesting the firebase-provided env variables
    const projectId : string | undefined = JSON.parse(<string>process.env.FIREBASE_CONFIG).projectId
    if (!projectId) throw new Error("Invalid project id found during env ingestion")
    builtInEnvVariables.projectId = projectId
    //FUNCTIONS_EMULATOR is a not-very-well-documented feature
    //https://github.com/firebase/firebase-tools/issues/2439
    builtInEnvVariables.runningInEmulator = process.env.FUNCTIONS_EMULATOR
}