/**
 * Wraps a promise in a timeout using promise.race
 * If the promise is timed out, it rejects and returns 'Timed out'
 * @param {Promise} promise The promise to time
 * @param {Number} ms The timeout in ms
 */
//https://italonascimento.github.io/applying-a-timeout-to-your-promises/
export const timedPromise = (promise, ms) => {

  // Create a promise that rejects in <ms> milliseconds
  let timeout = new Promise((resolve, reject) => {
    setTimeout(() => reject({
      name: "timeout",
      message: `Your Promise timed out after ${ms} milliseconds`
    }),
      ms)
  })

  // Returns a race between our timeout and the passed in promise
  return Promise.race([
    promise,
    timeout
  ])
}

export const SHORT_TIMEOUT = 7000
export const MEDIUM_TIMEOUT = 10000
export const LONG_TIMEOUT = 15000



/**
 * Determines is a string is only whitespace
 * @param {string} str The stirng
 */
//https://stackoverflow.com/questions/10261986/how-to-detect-string-which-contains-only-spaces/50971250
export const isOnlyWhitespace = (str) => {
  return str.replace(/\s/g, '').length === 0
}



/**
 * Converts epoch timestamps to date strings
 * @param {Number} epochMillis The epoch timestamp
 */
export const epochToDateString = (epochMillis) => {
  let options = {
    hour: "2-digit", minute: "2-digit", timeZoneName: "short",
    day: "2-digit", month: "short", year: "numeric"
  }
  return new Date(epochMillis).toLocaleString(undefined, options)
}

export const logError = (error) => {
  console.log(error)
}

