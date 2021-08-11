/**
 * You're going to use this to make two env files in env (root level env): 
 * `env.prod.json` and `env.dev.json`
 * No optional fields.
 * All entries should have a depth of exactly 2.
 * Adding a field here means you should also add that field to envVariables
 * 
 * Valid types: string, boolean or number
 * string => "foo", "bar", etc are all valid
 * number => "123" or "123.124" are all valid, parseInt and parseFloat are automatically used
 * boolean => "yes" or "true" corresponds to true, everything else false
 */
interface EnvVariableTemplateInterface {
    broadcastCreation: {
        tasks_location: string
        functions_location: string
        service_account_email: string
        autodelete_task_queue_name: string
        fcm_task_queue_name: string
    },
    fcm: {
        app_bundle_id: string //For iOS
    },
    stats: {
        is_prod_server: boolean //If false, the other fields can be default values
        new_users_sheets_id: string
        new_user_slack_webhook: string
    },
    newsletter: {
        is_prod_server: boolean //If no, the other fields can be default values
        sendy_url: string //Without the trailing slash
        sendy_api_key: string
        news_newsletter_id: string
        support_newsletter_id: string
    },
    userDataEmailing: {
        email_host: string
        email_port: number
        use_tls: boolean
        email_address: string
        email_password: string
    },
    emailVerification: {
        email_host: string
        email_port: number
        use_tls: boolean
        email_address: string
        email_password: string
        follow_url: string //To prevent a auth/unauthorized-continue-uri error, whitelist this domain in your console
        functions_location: string
    }
}


/**
 * The environmental variables passed into the function by the developer.
 * Populated by envVariableIngestor.ts
 */
export const envVariables : EnvVariableTemplateInterface = {
    broadcastCreation: {
        tasks_location: "",
        functions_location: "",
        service_account_email: "",
        autodelete_task_queue_name: "",
        fcm_task_queue_name: ""
    },
    fcm: {
        app_bundle_id: ""
    },
    stats: {
        is_prod_server: false,
        new_users_sheets_id: "",
        new_user_slack_webhook: ""
    },
    newsletter: {
        is_prod_server: false,
        sendy_url: "",
        sendy_api_key: "",
        news_newsletter_id: "",
        support_newsletter_id: ""
    },
    userDataEmailing: {
        email_host: "",
        email_port: 0,
        use_tls: false,
        email_address: "",
        email_password: "",
    },
    emailVerification: {
        email_host: "",
        email_port: 0,
        use_tls: false,
        email_address: "",
        email_password: "",
        follow_url: "",
        functions_location: ""
    }
}


interface builtInEnvVariablesTemplate{
    projectId: string,
    runningInEmulator: string | undefined
}

/**
 * The environmental variables passed into the function be firebase.
 * Populated by envVariableIngestor.ts
 */
export const builtInEnvVariables : builtInEnvVariablesTemplate = {
    projectId: "",
    runningInEmulator: "" 
}
