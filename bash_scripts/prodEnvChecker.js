//Checks if we're using the dev or the prod environment
//Call like so: node prodEnvChecker.js $(firebase use)
function check() { 
    let currentProjectName = process.argv[2]
    const fs = require('fs');
    let availableProjectsFile = fs.readFileSync('.firebaserc');
    let availableProjects = JSON.parse(availableProjectsFile).projects;
    if (!availableProjects.dev || ! availableProjects.production){
        console.log("error")
    }else if (availableProjects.dev == currentProjectName){
        console.log("dev")
    }else if (availableProjects.production == currentProjectName){
        console.log("prod")
    }else{
        console.log("none")
    }
} 
check()