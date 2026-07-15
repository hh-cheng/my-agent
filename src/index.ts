const command = process.argv[2]

function reportStartupError(error: unknown) {
  console.error(error)
  process.exitCode = 1
}

if (command === 'init') {
  import('./config/init.js')
    .then((module) => module.runInit())
    .catch(reportStartupError)
} else {
  import('./main.js')
    .then((module) => module.startAgent())
    .catch(reportStartupError)
}
