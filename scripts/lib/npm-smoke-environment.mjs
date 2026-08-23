export function isolatedNpmEnvironment(baseEnvironment, userConfigPath) {
  const environment = {}

  for (const [name, value] of Object.entries(baseEnvironment)) {
    const normalizedName = name.toLowerCase().replaceAll('-', '_')
    if (
      normalizedName === 'npm_config_userconfig' ||
      normalizedName === 'npm_config_allow_scripts'
    ) {
      continue
    }
    environment[name] = value
  }

  environment.NPM_CONFIG_USERCONFIG = userConfigPath
  return environment
}
