// How the main process tells a window which trial features are on: a command-line argument
// (webPreferences.additionalArguments), read by the preload. No Node imports, so the sandboxed preload can use it.
const PREFIX = '--kept-features='

export const featureArgument = features => `${PREFIX}${Object.keys(features).filter(name => features[name] === true).join(',')}`
export function featuresFromArgv(argv) {
  const argument = argv.findLast(value => value.startsWith(PREFIX))
  return new Set(argument ? argument.slice(PREFIX.length).split(',').filter(Boolean) : [])
}
