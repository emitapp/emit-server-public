import { CloudTasksClient } from '@google-cloud/tasks'
import { builtInEnvVariables, envVariables } from './env/envVariables';

const TASKS_LOCATION = envVariables.broadcastCreation.tasks_location
const FUNCTIONS_LOCATION = envVariables.broadcastCreation.functions_location
const serviceAccountEmail = envVariables.broadcastCreation.service_account_email;


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
    epochTimeInMillis: number): Promise<any> => {

    const tasksClient = new CloudTasksClient()
    const project = builtInEnvVariables.projectId
    const queuePath: string = tasksClient.queuePath(project, TASKS_LOCATION, queueName)
    const callbackUrl = `https://${FUNCTIONS_LOCATION}-${project}.cloudfunctions.net/${callbackHttpFuncName}`


    const task = {
        httpRequest: {
            httpMethod: "POST",
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

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    //@ts-ignore
    const [response] = await tasksClient.createTask({ parent: queuePath, task })
    return response
}

/**
 * Deletes a Cloud task that's been previously queued
 * @param name the cancellationTaskPath
 */export const cancelTask = async (name: string): Promise<any> => {
    const tasksClient = new CloudTasksClient()
    await tasksClient.deleteTask({ name });
}

//TODO: Test what NOT_FOUND looks like
//https://googleapis.dev/nodejs/tasks/latest/v2.CloudTasksClient.html#runTask
//also https://stackoverflow.com/questions/25529290/node-js-module-how-to-get-list-of-exported-functions
/**
 * Instantly runs a Cloud task that's been previously queued
 * @param name the cancellationTaskPath
 */
export const runTask = async (name: string): Promise<any> => {
    const tasksClient = new CloudTasksClient()
    const [response] = await tasksClient.runTask({ name });
    return response
}