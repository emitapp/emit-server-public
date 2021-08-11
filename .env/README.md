This folder should contain files that contain things like
env variables for functions, service account functions, etc.

It should also contain the two files that will contain the env variables 
for the prod and dev builds: env.prod.json and end.dev.json.

They should be plain json files with only string or map values. 
See functions/src/utils/env/envVariables.ts for what data they should contain.

See bash_scripts/copy-env-files to see what else should be in here.