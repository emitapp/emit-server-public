# https://firebase.googleblog.com/2018/01/streamline-typescript-development-cloud-functions.html

# Expected pwd: /functions
cd ..
sh bash_scripts/update-environment.sh

if [ $? -ne 0 ]; then
    cd functions
    exit 1
fi

cd functions

echo "Running tsc in watch mode 📹"
./node_modules/.bin/tsc --watch &

echo "Doing intial lint and build (subsequent builds via watch won't lint) 🏗️"
npm run lint
npm run build

echo "Copying over runtimeconfig.json and running shell 🌟"
firebase functions:config:get > .runtimeconfig.json
firebase functions:shell