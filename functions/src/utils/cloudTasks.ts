import * as functions from 'firebase-functions';

//@google-cloud/tasks doesn’t yet support import syntax at time of writing
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { CloudTasksClient } = require('@google-cloud/tasks')

const TASKS_LOCATION = functions.config().env.broadcastCreation.tasks_location
const FUNCTIONS_LOCATION = functions.config().env.broadcastCreation.functions_location
const serviceAccountEmail = functions.config().env.broadcastCreation.service_account_email;

/**
 * 
 * @param queueName The name of the queue
 * @param callbackHttpFuncName The name of the HTTP function callback
 * @param payload The payload being given to the callback
 * @param epochTimeInMillis The time this should be called in epoch timee
 * @returns A response from the Tasks Api
 * https://googleapis.dev/nodejs/tasks/latest/google.cloud.tasks.v2beta2.Task.html
 */
export const enqueueTask = async (
    queueName: string,
    callbackHttpFuncName: string,
    payload: Record<string, any>,
    epochTimeInMillis: number) : Promise<any> => {

    const tasksClient = new CloudTasksClient()
    const project = JSON.parse(<string>process.env.FIREBASE_CONFIG).projectId
    const queuePath: string = tasksClient.queuePath(project, TASKS_LOCATION, queueName)
    const callbackUrl = `https://${FUNCTIONS_LOCATION}-${project}.cloudfunctions.net/${callbackHttpFuncName}`

    const task = {
        httpRequest: {
            httpMethod: 'POST',
            url: callbackUrl,
            oidcToken: {
                serviceAccountEmail,
            },
            //Encoding to base64 is required by the Cloud Tasks API. 
            body: Buffer.from(JSON.stringify(payload)).toString('base64'),
            headers: {
                'Content-Type': 'application/json',
            },
        },
        scheduleTime: {
            seconds: epochTimeInMillis / 1000 //in epoch seconds
        }
    }

    const [response] = await tasksClient.createTask({ parent: queuePath, task })
    return response
}