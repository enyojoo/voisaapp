const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

const genaiWebEntry = path.resolve(
  __dirname,
  'node_modules/@google/genai/dist/web/index.mjs',
);

const defaultResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === '@google/genai/web' || moduleName === '@google/genai') {
    return { type: 'sourceFile', filePath: genaiWebEntry };
  }

  if (defaultResolveRequest) {
    return defaultResolveRequest(context, moduleName, platform);
  }

  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
