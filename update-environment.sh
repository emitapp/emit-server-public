projectState=$(node prodEnvChecker.js $(firebase use))

if [[ $projectState = "dev" ]]
then
  echo "💻Applying dev environment configuration"
  firebase functions:config:unset env 
  firebase functions:config:set env="$(cat env.dev.json)"
elif [[ $projectState = "prod" ]]
then
  echo "📲Applying production environment configuration"
  firebase functions:config:unset env 
  firebase functions:config:set env="$(cat env.prod.json)"
elif [[ $projectState = "none" ]]
then
  echo "🤷🏿‍♂️Your current project is using neither the 'dev' or the 'production' alias"
  # exit from shell or function but don't exit interactive shell
  [[ "$0" = "$BASH_SOURCE" ]] && exit 1 || return 1 
else
  echo "🛑Your .firebaserc doesn't have the 'dev' or the 'production' alias"
  # exit from shell or function but don't exit interactive shell
  [[ "$0" = "$BASH_SOURCE" ]] && exit 1 || return 1 
fi